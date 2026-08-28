import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BotProfile, DshAgentOptions, ModelOverride } from './types.js'

interface AgentHandleLike {
  readonly agent: Agent
  dispose?(): Promise<void>
}

interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
  currentInitiator?(): Agent | undefined
}

type AgentSetupLike = (agentCtx: Context) => void | Promise<void>

export interface AgentDispatchIdentity {
  /** Turn that the next ordinary follow-up will open. */
  readonly turn: number
  /** Events appended before dispatch are stale even if delivered later. */
  readonly eventSeqFloor: number
}

interface CommandRuntimeLike {
  execute(agent: Agent, line: string, signal: AbortSignal): Promise<{
    result: { kind: string; text?: string }
  } | undefined>
}

interface AgentDefaultModelLike {
  currentSelection(): { provider?: unknown; model?: unknown }
}

function service<T>(ctx: Context, name: string): T | undefined {
  const candidate = ctx as unknown as {
    get?: (serviceName: string) => T | undefined
    [key: string]: unknown
  }
  if (typeof candidate.get === 'function') {
    try {
      const value = candidate.get(name)
      if (value !== undefined) return value
    } catch {
      // The service may not be part of a minimal/headless composition.
    }
  }
  try {
    return candidate[name] as T | undefined
  } catch {
    return undefined
  }
}

export function stableSessionId(targetKey: string, profile: string, generation: number): SessionId {
  const digest = createHash('sha256')
    .update(`${targetKey}\0${profile}\0${generation}`)
    .digest('hex')
    .slice(0, 32)
  return `hermes-bot-${digest}` as SessionId
}

export function profileOptions(profile: BotProfile, modelOverride?: ModelOverride | string): DshAgentOptions {
  const override: ModelOverride | undefined = modelOverride === undefined
    ? undefined
    : typeof modelOverride === 'string' ? { model: modelOverride } : modelOverride
  const provider = override?.provider ?? profile.provider
  const model = override?.model ?? profile.model
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
  }
}

/** Programmatic agents inherit the DSH default model before bot overrides. */
export function agentOptions(ctx: Context, profile: BotProfile, modelOverride?: ModelOverride | string): DshAgentOptions {
  const defaults = service<AgentDefaultModelLike>(ctx, 'agentDefaultModel')
  let defaultOptions: DshAgentOptions = {}
  try {
    const selection = defaults?.currentSelection()
    defaultOptions = {
      ...(typeof selection?.provider === 'string' ? { provider: selection.provider } : {}),
      ...(typeof selection?.model === 'string' ? { model: selection.model } : {}),
    }
  } catch {
    // Minimal/headless compositions may not install the default-model service.
  }
  return { ...defaultOptions, ...profileOptions(profile, modelOverride) }
}

/** The only module that knows how Bot messages enter DeepSeek Harness. */
export class HarnessBridge {
  private readonly agents: AgentRegistryLike
  /** Bot worker / internal Fleet runs (fleet handoff, etc.). */
  private readonly internalToolsConfigured = new WeakSet<object>()
  /** Owner DSH web user sessions (bot_create_draft / bot_update_draft). */
  private readonly userToolsConfigured = new WeakSet<object>()

  public constructor(private readonly ctx: Context) {
    const agents = service<AgentRegistryLike>(ctx, 'agents')
    if (!agents) throw new Error('DeepSeek Harness Agent service is not available')
    this.agents = agents
  }

  public getAgent(sessionId: SessionId): Agent | undefined {
    return this.agents.get(sessionId)
  }

  /** A running turn or queued inbox item is lifecycle-active work. */
  public isBusy(sessionId: SessionId): boolean {
    const agent = this.agents.get(sessionId) as unknown as {
      readonly status?: unknown
      readonly inbox?: { readonly hasPending?: unknown }
    } | undefined
    return agent?.status === 'running' || agent?.inbox?.hasPending === true
  }

  public async resumeOrCreate(
    sessionId: SessionId,
    profile: BotProfile,
    modelOverride?: ModelOverride | string,
    setup?: AgentSetupLike,
  ): Promise<Agent> {
    const live = this.agents.get(sessionId)
    if (live) {
      await this.configureAgent(live, setup)
      return live
    }
    const options = agentOptions(this.ctx, profile, modelOverride)
    try {
      const resumed = await this.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: options,
        ...(setup === undefined ? {} : { setup }),
      })
      if (setup !== undefined) this.internalToolsConfigured.add(resumed.agent as object)
      return resumed.agent
    } catch (resumeError: unknown) {
      try {
        const created = await this.agents.create({
          sessionId,
          agentOptions: options,
          meta: { agentPreset: profile.name, cwd: process.cwd() },
          ...(setup === undefined ? {} : { setup }),
        })
        if (setup !== undefined) this.internalToolsConfigured.add(created.agent as object)
        return created.agent
      } catch (createError: unknown) {
        throw new Error(`could not resume or create DSH session: ${String(createError)} (resume: ${String(resumeError)})`)
      }
    }
  }

  private async configureAgent(agent: Agent, setup?: AgentSetupLike): Promise<void> {
    if (setup === undefined || this.internalToolsConfigured.has(agent as object)) return
    const agentContext = (agent as unknown as { readonly ctx?: Context }).ctx
    if (agentContext === undefined) return
    await setup(agentContext)
    this.internalToolsConfigured.add(agent as object)
  }

  /**
   * Install owner-only user Fleet tools on an existing native DSH web Agent.
   * Uses a separate configured set from internal/worker tool installation so
   * workflow agents are never blocked from receiving fleet handoff tools.
   */
  public async configureUserFleetTools(sessionId: SessionId, setup: AgentSetupLike): Promise<boolean> {
    if (String(sessionId).startsWith('hermes-bot-')) return false
    const agent = this.agents.get(sessionId)
    if (!agent || this.userToolsConfigured.has(agent as object)) return false
    const agentContext = (agent as unknown as { readonly ctx?: Context }).ctx
    if (agentContext === undefined) return false
    await setup(agentContext)
    this.userToolsConfigured.add(agent as object)
    return true
  }

  public async followup(agent: Agent, text: string): Promise<void> {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-hermes-bot', form: 'relay' },
    })
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return
    }
    // Compatibility fallback for an early developer-preview runtime.
    const legacy = agent as unknown as {
      send?: (value: unknown, target: unknown, wakeup: boolean) => void
    }
    if (typeof legacy.send !== 'function') throw new Error('DSH Agent does not expose followup/send')
    legacy.send(message, { kind: 'next-turn' }, true)
  }

  /** Bind one Fleet delivery to the next concrete DSH turn before followup(). */
  public dispatchIdentity(agent: Agent): AgentDispatchIdentity {
    const session = agent.session
    let latestTurn = 0
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event === null || typeof event !== 'object') continue
      const data = (event as { readonly data?: unknown }).data
      if (data === null || typeof data !== 'object') continue
      const turn = (data as { readonly turn?: unknown }).turn
      if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1) {
        latestTurn = turn
        break
      }
    }
    return { turn: latestTurn + 1, eventSeqFloor: session.seq }
  }

  public stop(agent: Agent): void {
    agent.cancel({ kind: 'user' })
  }

  public async waitUntilIdle(agent: Agent): Promise<void> {
    const candidate = agent as unknown as { whenIdle?: () => Promise<void> }
    if (typeof candidate.whenIdle === 'function') await candidate.whenIdle()
  }

  public async executeDshCommand(agent: Agent, line: string, signal: AbortSignal): Promise<string | undefined> {
    const commands = service<CommandRuntimeLike>(this.ctx, 'commands')
    if (!commands || typeof commands.execute !== 'function') return undefined
    const execution = await commands.execute(agent, line, signal)
    if (!execution) return undefined
    return execution.result.text ?? (execution.result.kind === 'success' ? '命令已完成。' : '命令未成功完成。')
  }

  public liveStatus(sessionId: SessionId): Record<string, unknown> {
    const agent = this.agents.get(sessionId)
    if (!agent) return { live: false }
    return {
      live: true,
      status: agent.status,
      provider: agent.options.provider,
      model: agent.options.model,
      sessionId: String(agent.id),
    }
  }
}
