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

interface CommandRuntimeLike {
  execute(agent: Agent, line: string, signal: AbortSignal): Promise<{
    result: { kind: string; text?: string }
  } | undefined>
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
    : typeof modelOverride === 'string'
      ? { model: modelOverride }
      : modelOverride
  const provider = override?.provider ?? profile.provider
  const model = override?.model ?? profile.model
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
  }
}

/** The only module that knows how Bot messages enter DeepSeek Harness. */
export class HarnessBridge {
  private readonly agents: AgentRegistryLike

  public constructor(private readonly ctx: Context) {
    const agents = service<AgentRegistryLike>(ctx, 'agents')
    if (!agents) throw new Error('DeepSeek Harness Agent service is not available')
    this.agents = agents
  }

  public getAgent(sessionId: SessionId): Agent | undefined {
    return this.agents.get(sessionId)
  }

  public async resumeOrCreate(sessionId: SessionId, profile: BotProfile, modelOverride?: ModelOverride | string): Promise<Agent> {
    const live = this.agents.get(sessionId)
    if (live) return live
    const options = profileOptions(profile, modelOverride)
    try {
      const resumed = await this.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: options,
      })
      return resumed.agent
    } catch (resumeError: unknown) {
      try {
        const created = await this.agents.create({
          sessionId,
          agentOptions: options,
          meta: { agentPreset: profile.name },
        })
        return created.agent
      } catch (createError: unknown) {
        throw new Error(`could not resume or create DSH session: ${String(createError)} (resume: ${String(resumeError)})`)
      }
    }
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

  public stop(agent: Agent): void {
    agent.cancel({ kind: 'user' })
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
