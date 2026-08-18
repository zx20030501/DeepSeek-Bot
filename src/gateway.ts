import { randomInt } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { InboundWal, Outbox } from './durable.js'
import { CollaborationHub, CollaborationStore, type BotMessageEnvelope, type BotMessageResult, type SendBotMessageInput } from './collaboration.js'
import {
  parseBotCommand,
  parseModelOverride,
  formatModelOverride,
  formatHelp,
  textFromContent,
  redactId,
} from './commands.js'
import { HarnessBridge, stableSessionId } from './harness-bridge.js'
import { JsonState } from './state.js'
import { PairingStore } from './pairing.js'
import { FeishuTransport } from './feishu.js'
import { TelegramTransport } from './telegram.js'
import type {
  BotGatewayConfig,
  BotProfile,
  BotStateFile,
  BotTarget,
  BotTransport,
  ChatBinding,
  GatewayInboundDiagnostics,
  InboundMessage,
  InboundDecisionDiagnostic,
  ModelOverride,
  OutboxItem,
  GatewayDiscoveryCandidate,
  GatewayDiscoveryStatus,
} from './types.js'

interface SessionLike { readonly id: unknown }

interface CollaborationRun {
  readonly parts: string[]
  readonly resolve: (result: BotMessageResult) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface DiscoveryState {
  readonly command: string
  readonly expiresAt: number
  readonly candidate?: GatewayDiscoveryCandidate
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringList(values: readonly (string | number)[] | undefined): Set<string> {
  return new Set((values ?? []).map(value => String(value)))
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

function targetKey(target: BotTarget): string {
  return [target.platform, target.chatId, target.threadId ?? ''].join(':')
}

function sessionKey(sessionId: unknown): string {
  return String(sessionId)
}

function collaborationPrompt(message: BotMessageEnvelope): string {
  return [
    'Internal Bot-to-Bot collaboration message.',
    'Message ID: ' + message.id,
    'Kind: ' + message.kind,
    'From Bot: ' + message.from.bot,
    'To Bot: ' + message.to.bot,
    'Task ID: ' + (message.taskId ?? 'none'),
    'Run ID: ' + (message.runId ?? 'none'),
    'Correlation ID: ' + message.correlationId,
    'Reply To: ' + (message.replyTo ?? 'none'),
    'Payload JSON: ' + JSON.stringify(message.payload),
    message.expectReply
      ? 'Return a concise result for the requesting Bot. Do not call external messaging APIs.'
      : 'This is a report message. Summarize or use it as context; no Bot reply is required.',
  ].join('\\n')
}

export function discoveryCandidateFor(
  message: InboundMessage,
  command: string,
): GatewayDiscoveryCandidate | undefined {
  if (message.target.platform !== 'feishu' || message.target.chatType !== 'dm' || message.text.trim() !== command || message.target.userId === undefined) return undefined
  return {
    receivedAt: Date.now(),
    userId: message.target.userId,
    chatId: message.target.chatId,
    ...(message.target.chatType === undefined ? {} : { chatType: message.target.chatType }),
  }
}

export function nextModelOverride(
  current: Pick<ChatBinding, 'modelOverride'>,
  requested: ModelOverride | string | null | undefined,
): Pick<ChatBinding, 'modelOverride'> {
  const value = requested === null ? undefined : requested ?? current.modelOverride
  return value === undefined ? {} : { modelOverride: value }
}

function defaultState(): BotStateFile {
  return { version: 1, bindings: {}, sessions: {} }
}

function normalizeProfiles(config: BotGatewayConfig): Map<string, BotProfile> {
  const profiles = new Map<string, BotProfile>()
  profiles.set('default', { name: 'default', title: 'Hermes' })
  for (const [name, raw] of Object.entries(config.profiles ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)) continue
    profiles.set(name, { name, ...asRecord(raw) } as BotProfile)
  }
  return profiles
}

export function normalizeConfig(raw: unknown = {}): BotGatewayConfig {
  const input = asRecord(raw)
  const telegram = asRecord(input.telegram)
  const feishu = asRecord(input.feishu)
  const access = asRecord(input.access)
  const envUsers = (firstEnv('DEEPSEEK_BOT_ALLOWED_USERS', 'DSH_HERMES_BOT_ALLOWED_USERS') ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const envChats = (firstEnv('DEEPSEEK_BOT_ALLOWED_CHATS', 'DSH_HERMES_BOT_ALLOWED_CHATS') ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const telegramToken = typeof telegram.token === 'string'
    ? telegram.token
    : firstEnv('DEEPSEEK_BOT_TELEGRAM_TOKEN', 'DSH_HERMES_BOT_TELEGRAM_TOKEN')
  const feishuAppId = typeof feishu.appId === 'string'
    ? feishu.appId
    : firstEnv('DEEPSEEK_BOT_FEISHU_APP_ID', 'DSH_HERMES_BOT_FEISHU_APP_ID')
  const feishuAppSecret = typeof feishu.appSecret === 'string'
    ? feishu.appSecret
    : firstEnv('DEEPSEEK_BOT_FEISHU_APP_SECRET', 'DSH_HERMES_BOT_FEISHU_APP_SECRET')
  const configuredStateDir = typeof input.stateDir === 'string' ? input.stateDir : firstEnv('DEEPSEEK_BOT_HOME', 'DSH_HERMES_BOT_HOME')
  const profiles: Record<string, Omit<BotProfile, 'name'>> = {}
  const rawProfiles = asRecord(input.profiles)
  for (const [name, value] of Object.entries(rawProfiles)) profiles[name] = asRecord(value) as Omit<BotProfile, 'name'>
  return {
    enabled: input.enabled !== false,
    ...(configuredStateDir === undefined ? {} : { stateDir: configuredStateDir }),
    defaultProfile: typeof input.defaultProfile === 'string' ? input.defaultProfile : 'default',
    profiles,
    access: {
      mode: access.mode === 'open' ? 'open' : 'allowlist',
      userIds: Array.isArray(access.userIds) ? access.userIds as (string | number)[] : envUsers,
      chatIds: Array.isArray(access.chatIds) ? access.chatIds as (string | number)[] : envChats,
      pairing: access.pairing !== false,
      notifyUnauthorized: access.notifyUnauthorized === true,
    },
    telegram: {
      enabled: telegram.enabled !== false,
      ...(telegramToken === undefined ? {} : { token: telegramToken }),
      pollTimeoutSeconds: typeof telegram.pollTimeoutSeconds === 'number' ? telegram.pollTimeoutSeconds : 30,
      requestTimeoutMs: typeof telegram.requestTimeoutMs === 'number' ? telegram.requestTimeoutMs : 70_000,
      maxAttempts: typeof telegram.maxAttempts === 'number' ? telegram.maxAttempts : 5,
    },
    feishu: {
      enabled: feishu.enabled !== false,
      ...(feishuAppId === undefined ? {} : { appId: feishuAppId }),
      ...(feishuAppSecret === undefined ? {} : { appSecret: feishuAppSecret }),
      domain: feishu.domain === 'lark' || firstEnv('DEEPSEEK_BOT_FEISHU_DOMAIN', 'DSH_HERMES_BOT_FEISHU_DOMAIN') === 'lark' ? 'lark' : 'feishu',
      requireMention: feishu.requireMention !== false,
      handshakeTimeoutMs: typeof feishu.handshakeTimeoutMs === 'number' ? feishu.handshakeTimeoutMs : 15_000,
      maxMessageChars: typeof feishu.maxMessageChars === 'number' ? feishu.maxMessageChars : 4_000,
    },
    maxInboundAttempts: typeof input.maxInboundAttempts === 'number' ? input.maxInboundAttempts : 3,
    outboxMaxAttempts: typeof input.outboxMaxAttempts === 'number' ? input.outboxMaxAttempts : 5,
    retryBaseMs: typeof input.retryBaseMs === 'number' ? input.retryBaseMs : 1_000,
    retryMaxMs: typeof input.retryMaxMs === 'number' ? input.retryMaxMs : 60_000,
  }
}

/** Hermes-style message gateway implemented as a DSH plugin boundary. */
export class BotGateway {
  private config: BotGatewayConfig
  private readonly profiles: Map<string, BotProfile>
  private readonly state: JsonState<BotStateFile>
  private readonly pairing: PairingStore
  private readonly wal: InboundWal
  private readonly outbox: Outbox
  private transports: BotTransport[]
  private readonly transportByPlatform: Map<string, BotTransport>
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly inboundRetryTimers = new Set<ReturnType<typeof setTimeout>>()
  private bridge: HarnessBridge | undefined
  private started: Promise<void> = Promise.resolve()
  private stopped = false
  private running = false
  private durableLoaded = false
  private inboundReceived = 0
  private inboundAccepted = 0
  private inboundUnauthorized = 0
  private inboundDuplicate = 0
  private lastInboundDecision: InboundDecisionDiagnostic | null = null
  private discovery: DiscoveryState | undefined
  /** Latest inbound target, including reply context, for each live session. */
  private readonly sessionTargets = new Map<string, BotTarget>()
  private readonly collaboration: CollaborationHub
  private readonly collaborationRuns = new Map<string, CollaborationRun>()

  public constructor(private readonly ctx: Context, rawConfig: unknown = {}) {
    this.config = normalizeConfig(rawConfig)
    this.profiles = normalizeProfiles(this.config)
    if (!this.profiles.has(this.config.defaultProfile ?? 'default')) {
      this.profiles.set('default', { name: 'default', title: 'Hermes' })
    }
    const stateDir = resolve(
      this.config.stateDir
        ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'hermes-bot'),
    )
    this.state = new JsonState<BotStateFile>(join(stateDir, 'state.json'), defaultState())
    this.pairing = new PairingStore(join(stateDir, 'pairing.json'))
    this.wal = new InboundWal(join(stateDir, 'inbound-wal.jsonl'), this.config.maxInboundAttempts ?? 3)
    const collaborationStore = new CollaborationStore(
      join(stateDir, 'collaboration.jsonl'),
      this.config.maxInboundAttempts ?? 3,
    )
    this.collaboration = new CollaborationHub(
      collaborationStore,
      message => this.executeBotMessage(message),
      {
        retryBaseMs: this.config.retryBaseMs ?? 1_000,
        retryMaxMs: this.config.retryMaxMs ?? 60_000,
      },
    )
    this.transports = []
    this.transportByPlatform = new Map()
    this.installTransports(this.config)
    this.outbox = new Outbox(
      join(stateDir, 'outbox.jsonl'),
      async (item: OutboxItem) => {
        const transport = this.transportByPlatform.get(item.target.platform)
        if (!transport) throw new Error(`no enabled bot transport for ${item.target.platform}`)
        await transport.send(item.target, item.text)
      },
      this.config.outboxMaxAttempts ?? 5,
      this.config.retryBaseMs ?? 1_000,
      this.config.retryMaxMs ?? 60_000,
    )
  }

  public async start(): Promise<void> {
    if (this.running) {
      await this.started
      return
    }
    this.running = true
    this.stopped = false
    this.outbox.start()
    this.started = this.boot()
    try {
      await this.started
    } catch (error) {
      this.running = false
      throw error
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true
    this.running = false
    this.discovery = undefined
    for (const timer of this.inboundRetryTimers) clearTimeout(timer)
    this.inboundRetryTimers.clear()
    await this.started.catch(() => undefined)
    await this.stopTransports()
    await this.outbox.stop()
  }

  /** Apply settings changes without requiring the DSH process to restart. */
  public async reconfigure(rawConfig: unknown = {}): Promise<void> {
    const next = normalizeConfig(rawConfig)
    if (!this.running || this.stopped) {
      this.applyConfig(next)
      this.installTransports(next)
      return
    }
    await this.started.catch(() => undefined)
    if (!this.running || this.stopped) return
    await this.stopTransports()
    this.applyConfig(next)
    this.installTransports(next)
    await this.loadDurableState()
    await this.activateTransports(true)
  }

  private applyConfig(next: BotGatewayConfig): void {
    this.config = next
    this.profiles.clear()
    for (const [name, profile] of normalizeProfiles(next)) this.profiles.set(name, profile)
    if (!this.profiles.has(next.defaultProfile ?? 'default')) {
      this.profiles.set('default', { name: 'default', title: 'Hermes' })
    }
  }

  public onSessionEvent(session: SessionLike, event: unknown): void {
    void this.started.then(() => this.handleSessionEvent(session, event)).catch(error => this.log('warn', `session event handling failed: ${String(error)}`))
  }

  public status(): Record<string, unknown> {
    const config = this.config.access ?? {}
    return {
      enabled: this.config.enabled !== false,
      transports: Object.fromEntries(this.transports.map(transport => [
        transport.platform,
        transport.status?.() ?? { platform: transport.platform, running: false },
      ])),
      accessMode: config.mode ?? 'allowlist',
      profileCount: this.profiles.size,
      laneCount: this.lanes.size,
      collaboration: {
        activeRuns: this.collaborationRuns.size,
      },
      inbound: this.inboundDiagnostics(),
      pairing: {
        enabled: config.pairing !== false,
        ...this.pairing.status(),
      },
      discovery: this.discoveryStatus(),
    }
  }

  /** Send a typed message to another configured Bot profile. */
  public async sendBotMessage(input: SendBotMessageInput): Promise<BotMessageEnvelope> {
    const sender = this.profiles.get(input.from.bot)
    const recipient = this.profiles.get(input.to.bot)
    if (!sender || sender.enabled === false) throw new Error('unknown or disabled sender Bot profile: ' + input.from.bot)
    if (!recipient || recipient.enabled === false) throw new Error('unknown or disabled recipient Bot profile: ' + input.to.bot)
    return this.collaboration.send(input)
  }

  /** Start a short-lived, local-UI-driven identity discovery flow. */
  public beginDiscovery(ttlMs = 5 * 60 * 1_000): GatewayDiscoveryStatus {
    const expiresAt = Date.now() + Math.max(30_000, Math.min(15 * 60 * 1_000, ttlMs))
    const code = String(randomInt(100_000, 1_000_000))
    this.discovery = { command: `/bind ${code}`, expiresAt }
    return this.discoveryStatus()
  }

  public discoveryCandidate(): GatewayDiscoveryCandidate | undefined {
    const state = this.discovery
    if (state === undefined || state.expiresAt <= Date.now()) return undefined
    return state.candidate
  }

  public clearDiscovery(): void {
    this.discovery = undefined
  }

  public async approvePairing(code: string): Promise<GatewayDiscoveryCandidate | undefined> {
    if (this.config.access?.pairing === false) return undefined
    const request = await this.pairing.approve(code)
    if (request === undefined) return undefined
    const target: BotTarget = {
      platform: request.platform,
      chatId: request.chatId,
      userId: request.userId,
      ...(request.chatType === undefined ? {} : { chatType: request.chatType }),
    }
    void this.sendText(
      target,
      '配对成功。请在此飞书聊天中发送 /new 开始新的会话，然后再正常使用。',
      `pairing-approved:${request.platform}:${request.userId}:${Date.now()}`,
    ).catch(error => this.log('warn', `pairing confirmation failed: ${String(error)}`))
    return {
      receivedAt: request.createdAt,
      userId: request.userId,
      chatId: request.chatId,
      ...(request.chatType === undefined ? {} : { chatType: request.chatType }),
    }
  }

  public async revokePairing(platform: string, userId: string): Promise<boolean> {
    return this.pairing.revoke(platform, userId)
  }

  private discoveryStatus(): GatewayDiscoveryStatus {
    const state = this.discovery
    if (state === undefined || state.expiresAt <= Date.now()) return { active: false }
    return {
      active: state.candidate === undefined,
      command: state.command,
      expiresAt: state.expiresAt,
      ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
    }
  }

  private async boot(): Promise<void> {
    if (this.config.enabled === false) return
    await this.loadDurableState()
    await this.activateTransports(true)
  }

  private async loadDurableState(): Promise<void> {
    if (this.durableLoaded) return
    await this.state.load()
    await this.pairing.load()
    await this.wal.load()
    await this.outbox.load()
    await this.collaboration.load()
    this.durableLoaded = true
  }

  private async activateTransports(recover: boolean): Promise<void> {
    if (this.config.enabled === false) return
    if (this.transports.length === 0) {
      this.log('warn', 'no enabled Telegram or Feishu transport configured; Bot Gateway is installed but idle')
    }
    if (!this.bridge) {
      try {
        this.bridge = new HarnessBridge(this.ctx)
      } catch (error: unknown) {
        this.log('warn', `DeepSeek Harness Agent service unavailable: ${String(error)}`)
        return
      }
    }
    if (recover) {
      for (const item of await this.wal.pending()) {
        void this.queueInbound(item.message, item.id)
      }
      void this.outbox.flush().catch(error => this.log('warn', `outbox recovery failed: ${String(error)}`))
      void this.collaboration.dispatchPending().catch(error => this.log('warn', `collaboration recovery failed: ${String(error)}`))
    }
    if (this.transports.length === 0) return
    for (const transport of this.transports) {
      void transport.start(message => this.acceptInbound(message)).catch(error => {
        if (!this.stopped && this.transportByPlatform.get(transport.platform) === transport) {
          this.log('error', `${transport.platform} transport stopped: ${String(error)}`)
        }
      })
    }
    this.log('info', `Bot Gateway started: ${this.transports.map(transport => transport.platform).join(', ')}`)
  }

  private installTransports(config: BotGatewayConfig): void {
    const transports: BotTransport[] = []
    const token = config.telegram?.token
    if (config.telegram?.enabled !== false && token) transports.push(new TelegramTransport(config.telegram))
    const feishu = config.feishu
    if (feishu && feishu.enabled !== false && feishu.appId && feishu.appSecret) {
      transports.push(new FeishuTransport(feishu))
    }
    this.transports = transports
    this.transportByPlatform.clear()
    for (const transport of transports) this.transportByPlatform.set(transport.platform, transport)
  }

  private async stopTransports(): Promise<void> {
    const current = this.transports
    this.transports = []
    this.transportByPlatform.clear()
    await Promise.all(current.map(transport => transport.stop()))
  }

  private async acceptInbound(message: InboundMessage): Promise<void> {
    this.inboundReceived += 1
    if (this.acceptDiscoveryMessage(message)) return
    if (!(await this.authorized(message))) {
      this.inboundUnauthorized += 1
      this.lastInboundDecision = this.makeInboundDiagnostic(message, 'unauthorized', 'not_in_allowlist')
      if (this.config.access?.pairing !== false && message.target.chatType === 'dm' && message.target.userId !== undefined) {
        const offer = await this.pairing.request(message.target)
        if (offer !== undefined) {
          if (offer.shouldNotify) {
            await this.sendText(
              message.target,
              `此用户还没有完成配对。请把配对码 ${offer.request.code} 提供给 Bot 管理员，在 DSH 设置页的“安全配对”中输入并确认。配对码 1 小时内有效。`,
              `pairing:${message.target.platform}:${message.target.userId}:${offer.request.code}`,
            )
          }
          this.log('info', `pairing request created for user=${redactId(message.target.userId)}`)
          return
        }
      }
      if (this.config.access?.notifyUnauthorized) {
        await this.sendText(
          message.target,
          '此 Bot 当前未授权该用户或聊天。请由管理员把你的 user/chat ID 加入 allowlist。',
          `unauthorized:${message.id}`,
        )
      }
      this.log('warn', `unauthorized message from user=${redactId(message.target.userId)} chat=${redactId(message.target.chatId)}`)
      return
    }
    const accepted = await this.wal.accept(message)
    if (!accepted.inserted || accepted.item.state !== 'accepted') {
      this.inboundDuplicate += 1
      this.lastInboundDecision = this.makeInboundDiagnostic(message, 'duplicate', accepted.inserted ? `wal_${accepted.item.state}` : 'already_seen')
      return
    }
    this.inboundAccepted += 1
    this.lastInboundDecision = this.makeInboundDiagnostic(message, 'accepted', 'allowlist_passed')
    void this.queueInbound(message, accepted.item.id)
  }

  /**
   * Capture only the message carrying the one-time challenge. It deliberately
   * bypasses the normal allowlist and Agent path, then expires after one hit.
   */
  private acceptDiscoveryMessage(message: InboundMessage): boolean {
    const state = this.discovery
    if (state === undefined || state.candidate !== undefined || state.expiresAt <= Date.now()) return false
    if (message.target.platform !== 'feishu' || message.target.chatType !== 'dm') return false
    const candidate = discoveryCandidateFor(message, state.command)
    if (candidate === undefined) return false
    this.discovery = { ...state, candidate }
    void this.sendText(
      message.target,
      '已识别你的飞书用户 ID。请回到 DSH 设置页，确认 UID 已自动填入后点击“保存并启动”。',
      `discovery:${message.id}`,
    ).catch(error => this.log('warn', `discovery confirmation failed: ${String(error)}`))
    this.log('info', `Feishu user identity discovered: user=${redactId(candidate.userId)} chat=${redactId(candidate.chatId)}`)
    return true
  }

  private inboundDiagnostics(): GatewayInboundDiagnostics {
    return {
      received: this.inboundReceived,
      accepted: this.inboundAccepted,
      unauthorized: this.inboundUnauthorized,
      duplicate: this.inboundDuplicate,
      last: this.lastInboundDecision,
    }
  }

  private makeInboundDiagnostic(
    message: InboundMessage,
    decision: InboundDecisionDiagnostic['decision'],
    reason: string,
  ): InboundDecisionDiagnostic {
    return {
      receivedAt: Date.now(),
      platform: message.target.platform,
      messageId: message.id,
      ...(message.target.userId === undefined ? {} : { userId: message.target.userId }),
      chatId: message.target.chatId,
      ...(message.target.chatType === undefined ? {} : { chatType: message.target.chatType }),
      textLength: message.text.length,
      decision,
      reason,
    }
  }

  private async queueInbound(message: InboundMessage, walId: string): Promise<void> {
    const lane = targetKey(message.target)
    const previous = this.lanes.get(lane) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.processInbound(message, walId))
      .finally(() => {
        if (this.lanes.get(lane) === current) this.lanes.delete(lane)
      })
    this.lanes.set(lane, current)
    await current
  }

  private async processInbound(message: InboundMessage, walId: string): Promise<void> {
    const binding = await this.bindingFor(message.target)
    await this.rememberSessionTarget(binding.sessionId, message.target)
    const profile = this.profiles.get(binding.profile) ?? this.profiles.get('default')!
    const command = parseBotCommand(message.text)
    if (command && await this.handleLocalCommand(message, walId, binding, command.name, command.args)) return
    const claimed = await this.wal.claim(walId, binding.sessionId)
    if (!claimed || !this.bridge) return
    try {
      const transport = this.transportByPlatform.get(message.target.platform)
      if (transport?.typing) void transport.typing(message.target).catch(() => undefined)
      const agent = await this.bridge.resumeOrCreate(
        binding.sessionId as SessionId,
        profile,
        binding.modelOverride,
      )
      // Hermes routes known DSH commands natively; an unknown /xxx is still a
      // normal Agent prompt and is never silently discarded.
      if (command) {
        const commandResult = await this.bridge.executeDshCommand(agent, message.text, new AbortController().signal)
        if (commandResult !== undefined) {
          await this.sendText(message.target, commandResult, `command:${message.id}`)
          await this.wal.complete(walId)
          return
        }
      }
      await this.bridge.followup(agent, message.text)
    } catch (error: unknown) {
      await this.handleInboundFailure(message, walId, error)
    }
  }

  private async handleInboundFailure(
    message: InboundMessage,
    walId: string,
    error: unknown,
    retry = true,
    finalText = `Agent 处理失败：${String(error)}`,
    finalKey = `error:${message.id}`,
  ): Promise<void> {
    const item = await this.wal.fail(walId, error, retry)
    if (!item) return
    if (item.state === 'failed') {
      await this.sendText(message.target, finalText, finalKey)
      return
    }
    this.scheduleInboundRetry(message, walId, item.attempts)
  }

  private scheduleInboundRetry(message: InboundMessage, walId: string, attempts: number): void {
    if (this.stopped) return
    const base = Math.max(0, this.config.retryBaseMs ?? 1_000)
    const maximum = Math.max(base, this.config.retryMaxMs ?? 60_000)
    const delay = Math.min(maximum, base * 2 ** Math.max(0, attempts - 1))
    let timer: ReturnType<typeof setTimeout>
    timer = setTimeout(() => {
      this.inboundRetryTimers.delete(timer)
      void this.queueInbound(message, walId).catch(error => {
        this.log('warn', `inbound retry failed: ${String(error)}`)
      })
    }, delay)
    timer.unref?.()
    this.inboundRetryTimers.add(timer)
  }

  private async handleLocalCommand(
    message: InboundMessage,
    walId: string,
    binding: ChatBinding,
    name: string,
    args: string,
  ): Promise<boolean> {
    if (!['new', 'reset', 'stop', 'status', 'help', 'bots', 'bot', 'model'].includes(name)) return false
    if (name === 'help') {
      await this.completeWithText(message, walId, binding, formatHelp())
      return true
    }
    if (name === 'status') {
      const pendingInbound = (await this.wal.pending()).length
      const pendingOutbound = await this.outbox.pendingCount()
      const live = this.bridge?.liveStatus(binding.sessionId as SessionId) ?? { live: false }
      await this.completeWithText(message, walId, binding, [
        'Bot Gateway 状态',
        `Transports: ${JSON.stringify(this.status().transports)}`,
        `Profile: ${binding.profile}`,
        `Session: ${binding.sessionId}`,
        `Agent: ${JSON.stringify(live)}`,
        `Inbound pending: ${pendingInbound}`,
        `Outbound pending: ${pendingOutbound}`,
      ].join('\n'))
      return true
    }
    if (name === 'bots') {
      const rows = [...this.profiles.values()]
        .filter(profile => profile.enabled !== false)
        .map(profile => `${profile.name}${profile.title ? ` — ${profile.title}` : ''}`)
      await this.completeWithText(message, walId, binding, `可用 Bot profiles：\n${rows.join('\n')}`)
      return true
    }
    if (name === 'stop') {
      const agent = this.bridge?.getAgent(binding.sessionId as SessionId)
      if (agent) this.bridge?.stop(agent)
      await this.completeWithText(message, walId, binding, agent ? '已请求停止当前 Agent 回合。' : '当前没有正在运行的 Agent。')
      return true
    }
    if (name === 'new' || name === 'reset') {
      const old = this.bridge?.getAgent(binding.sessionId as SessionId)
      if (old) this.bridge?.stop(old)
      const next = await this.rotateBinding(message.target, binding, binding.profile, binding.modelOverride)
      await this.completeWithText(message, walId, next, `已新建会话，当前 Bot：${next.profile}`)
      return true
    }
    if (name === 'bot') {
      if (!args) {
        await this.completeWithText(message, walId, binding, `当前 Bot：${binding.profile}\n使用 /bots 查看可用 profile。`)
        return true
      }
      const profile = this.profiles.get(args)
      if (!profile || profile.enabled === false) {
        await this.completeWithText(message, walId, binding, `未知 Bot profile：${args}`)
        return true
      }
      const old = this.bridge?.getAgent(binding.sessionId as SessionId)
      if (old) this.bridge?.stop(old)
      // A profile switch must start from the new profile's model settings.
      const next = await this.rotateBinding(message.target, binding, profile.name, null)
      await this.completeWithText(message, walId, next, `已切换到 Bot：${profile.title ?? profile.name}`)
      return true
    }
    if (name === 'model') {
      if (!args) {
        const profile = this.profiles.get(binding.profile)
        await this.completeWithText(
          message,
          walId,
          binding,
          `当前模型：${formatModelOverride(binding.modelOverride) ?? profile?.model ?? '由 DSH profile 决定'}`,
        )
        return true
      }
      const modelOverride = parseModelOverride(args)
      const next = await this.rotateBinding(message.target, binding, binding.profile, modelOverride)
      await this.completeWithText(
        message,
        walId,
        next,
        `下一回合将使用模型：${formatModelOverride(modelOverride)}`,
      )
      return true
    }
    return false
  }

  private async completeWithText(message: InboundMessage, walId: string, binding: ChatBinding, text: string): Promise<void> {
    await this.wal.claim(walId, binding.sessionId)
    await this.sendText(message.target, text, `command:${message.id}`)
    await this.wal.complete(walId)
  }

  private async bindingFor(target: BotTarget): Promise<ChatBinding> {
    const key = targetKey(target)
    const snapshot = await this.state.load()
    const existing = snapshot.bindings[key]
    if (existing) {
      this.sessionTargets.set(existing.sessionId, target)
      return existing
    }
    const profile = this.profiles.has(this.config.defaultProfile ?? '') ? this.config.defaultProfile! : 'default'
    const binding: ChatBinding = {
      key,
      target,
      profile,
      generation: 0,
      sessionId: String(stableSessionId(key, profile, 0)),
      updatedAt: Date.now(),
    }
    await this.state.update(current => {
      current.bindings[key] = binding
      current.sessions[binding.sessionId] = target
      return current
    })
    this.sessionTargets.set(binding.sessionId, target)
    return binding
  }

  private async rememberSessionTarget(sessionId: string, target: BotTarget): Promise<void> {
    this.sessionTargets.set(sessionId, target)
    await this.state.update(state => {
      state.sessions[sessionId] = target
      return state
    })
  }

  private async rotateBinding(
    target: BotTarget,
    current: ChatBinding,
    profile: string,
    modelOverride?: ModelOverride | string | null,
  ): Promise<ChatBinding> {
    const modelPatch = nextModelOverride(current, modelOverride)
    const { modelOverride: _oldModelOverride, ...withoutModelOverride } = current
    const next: ChatBinding = {
      ...withoutModelOverride,
      target,
      profile,
      generation: current.generation + 1,
      sessionId: String(stableSessionId(current.key, profile, current.generation + 1)),
      ...modelPatch,
      updatedAt: Date.now(),
    }
    await this.state.update(state => {
      state.bindings[current.key] = next
      state.sessions[next.sessionId] = target
      return state
    })
    this.sessionTargets.set(next.sessionId, target)
    return next
  }

  private async authorized(message: InboundMessage): Promise<boolean> {
    const access = this.config.access ?? {}
    if (access.mode === 'open') return true
    const users = stringList(access.userIds)
    const chats = stringList(access.chatIds)
    if ((message.target.userId !== undefined && users.has(message.target.userId)) || chats.has(message.target.chatId)) return true
    return access.pairing === true
      && message.target.userId !== undefined
      && await this.pairing.isApproved(message.target.platform, message.target.userId)
  }

  private async executeBotMessage(message: BotMessageEnvelope): Promise<BotMessageResult> {
    const profile = this.profiles.get(message.to.bot)
    if (!profile || profile.enabled === false) {
      throw new Error('unknown or disabled recipient Bot profile: ' + message.to.bot)
    }
    const bridge = this.bridge
    if (!bridge) throw new Error('DeepSeek Harness Agent service is not available')
    const sessionId = (message.to.sessionId ?? String(stableSessionId(
      'bot-collab:' + message.to.bot,
      message.to.bot,
      0,
    ))) as SessionId
    const id = sessionKey(sessionId)
    const agent = await bridge.resumeOrCreate(sessionId, profile)
    return new Promise<BotMessageResult>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const current = this.collaborationRuns.get(id)
        if (!current) return
        if (current.parts.length > 0) this.finishCollaborationRun(id)
        else this.finishCollaborationRun(id, new Error('Bot collaboration timed out without a response'))
      }, 120_000)
      timer.unref?.()
      this.collaborationRuns.set(id, {
        parts: [],
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      })
      void bridge.followup(agent, collaborationPrompt(message)).catch(error => {
        this.finishCollaborationRun(id, error)
      })
    })
  }

  private finishCollaborationRun(id: string, error?: unknown): void {
    const run = this.collaborationRuns.get(id)
    if (!run) return
    this.collaborationRuns.delete(id)
    clearTimeout(run.timer)
    if (error !== undefined) {
      run.reject(error)
      return
    }
    const text = run.parts.join('\\n').trim()
    run.resolve(text ? { text } : {})
  }

  private handleCollaborationSessionEvent(
    id: string,
    run: CollaborationRun,
    record: Record<string, unknown>,
  ): void {
    if (record.type === 'assistant/message') {
      const data = asRecord(record.data)
      const message = asRecord(data.message)
      const text = textFromContent(message.content)
      if (text) run.parts.push(text)
      return
    }
    if (record.type !== 'turn/end') return
    const reason = asRecord(asRecord(record.data).reason)
    const kind = String(reason.kind ?? '')
    if (kind === 'error' || kind === 'aborted') {
      this.finishCollaborationRun(id, new Error(kind === 'aborted'
        ? 'Bot collaboration Agent turn was aborted'
        : 'Bot collaboration Agent turn failed'))
      return
    }
    this.finishCollaborationRun(id)
  }

  private async handleSessionEvent(session: SessionLike, event: unknown): Promise<void> {
    const record = asRecord(event)
    const data = asRecord(record.data)
    const id = sessionKey(session.id)
    const state = this.state.snapshot()
    const target = this.sessionTargets.get(id) ?? state.sessions[id]
    const collaborationRun = this.collaborationRuns.get(id)
    if (collaborationRun !== undefined) {
      this.handleCollaborationSessionEvent(id, collaborationRun, record)
      return
    }
    if (!target) return
    if (record.type === 'assistant/message') {
      const message = asRecord(data.message)
      const text = textFromContent(message.content)
      if (!text) return
      const seq = String(record.seq ?? message.id ?? Date.now())
      await this.sendText(target, text, `assistant:${id}:${seq}`)
      const pending = await this.wal.pendingForSession(id)
      if (pending[0]) await this.wal.complete(pending[0].id)
      return
    }
    if (record.type === 'turn/end') {
      const reason = asRecord(data.reason)
      const kind = String(reason.kind ?? '')
      if (kind !== 'error' && kind !== 'aborted') return
      const pending = await this.wal.pendingForSession(id)
      if (!pending[0]) return
      const detail = kind === 'aborted' ? 'Agent 回合已停止。' : 'Agent 回合失败。'
      await this.handleInboundFailure(
        pending[0].message,
        pending[0].id,
        detail,
        kind !== 'aborted',
        detail,
        `turn-error:${id}:${String(record.seq ?? Date.now())}`,
      )
    }
  }

  private async sendText(target: BotTarget, text: string, key: string): Promise<void> {
    await this.outbox.enqueue({ key, target, text })
  }

  private transportFor(platform: string): BotTransport | undefined {
    return this.transportByPlatform.get(platform)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const logger = (this.ctx as unknown as { logger?: Record<string, (value: string) => void> }).logger
    const fn = logger?.[level]
    if (typeof fn === 'function') fn.call(logger, `[dsh-hermes-bot] ${message}`)
    else if (level === 'error') console.error(`[dsh-hermes-bot] ${message}`)
  }
}
