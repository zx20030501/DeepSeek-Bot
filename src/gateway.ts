import { randomInt, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { InboundWal, Outbox } from './durable.js'
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
import {
  BotDirectory,
  BotMailbox,
  GroupRoomStore,
  TaskRunStore,
  createEnvelope,
  parseBotMentions,
  type MailboxLease,
} from './collaboration.js'
import type {
  BotMessageEnvelope,
  BotDescriptor,
  BotCollaborationConfig,
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
  RunRecord,
  TaskRecord,
} from './types.js'

interface SessionLike { readonly id: unknown }

interface DiscoveryState {
  readonly command: string
  readonly expiresAt: number
  readonly candidate?: GatewayDiscoveryCandidate
}

interface InternalRun {
  readonly runId: string
  readonly botId: string
  readonly sessionId: string
  readonly lease: MailboxLease
  readonly envelope: BotMessageEnvelope
  readonly texts: string[]
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
  const collaboration = asRecord(input.collaboration)
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
    collaboration: {
      enabled: collaboration.enabled !== false,
      maxGroupBots: typeof collaboration.maxGroupBots === 'number' ? collaboration.maxGroupBots : 6,
      maxGroupTurns: typeof collaboration.maxGroupTurns === 'number' ? collaboration.maxGroupTurns : 3,
      maxGroupMessages: typeof collaboration.maxGroupMessages === 'number' ? collaboration.maxGroupMessages : 10,
      mailboxMaxAttempts: typeof collaboration.mailboxMaxAttempts === 'number' ? collaboration.mailboxMaxAttempts : 3,
      mailboxLeaseMs: typeof collaboration.mailboxLeaseMs === 'number' ? collaboration.mailboxLeaseMs : 120_000,
    },
  }
}

/** Hermes-style message gateway implemented as a DSH plugin boundary. */
export class BotGateway {
  private config: BotGatewayConfig
  private readonly profiles: Map<string, BotProfile>
  private readonly directory: BotDirectory
  private readonly state: JsonState<BotStateFile>
  private readonly pairing: PairingStore
  private readonly wal: InboundWal
  private readonly outbox: Outbox
  private readonly mailbox: BotMailbox
  private readonly tasks: TaskRunStore
  private readonly rooms: GroupRoomStore
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
  private readonly internalRuns = new Map<string, InternalRun>()
  private readonly internalRunBySession = new Map<string, string>()
  private readonly activeBotRuns = new Map<string, string>()
  private readonly collaborationWorkerId = `mesh-${process.pid}-${randomUUID()}`
  private collaborationDrain: Promise<void> | undefined
  private collaborationDrainTimer: ReturnType<typeof setTimeout> | undefined

  public constructor(private readonly ctx: Context, rawConfig: unknown = {}) {
    this.config = normalizeConfig(rawConfig)
    this.profiles = normalizeProfiles(this.config)
    if (!this.profiles.has(this.config.defaultProfile ?? 'default')) {
      this.profiles.set('default', { name: 'default', title: 'Hermes' })
    }
    this.directory = new BotDirectory(this.profiles.values())
    const stateDir = resolve(
      this.config.stateDir
        ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'hermes-bot'),
    )
    this.state = new JsonState<BotStateFile>(join(stateDir, 'state.json'), defaultState())
    this.pairing = new PairingStore(join(stateDir, 'pairing.json'))
    this.wal = new InboundWal(join(stateDir, 'inbound-wal.jsonl'), this.config.maxInboundAttempts ?? 3)
    this.mailbox = new BotMailbox(join(stateDir, 'mailbox.jsonl'), this.config.collaboration)
    this.tasks = new TaskRunStore(join(stateDir, 'tasks.jsonl'))
    this.rooms = new GroupRoomStore(join(stateDir, 'rooms.json'), this.config.collaboration)
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
    if (this.collaborationDrainTimer) clearTimeout(this.collaborationDrainTimer)
    this.collaborationDrainTimer = undefined
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
    this.directory.replace(this.profiles.values())
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
      bots: this.directory.list().map(bot => ({
        id: bot.id,
        title: bot.title,
        capabilities: [...bot.capabilities],
        skills: [...bot.skills],
        canonicalSessionId: bot.canonicalSessionId,
      })),
      collaboration: {
        enabled: this.config.collaboration?.enabled !== false,
        activeRuns: this.activeBotRuns.size,
        workerId: this.collaborationWorkerId,
      },
      laneCount: this.lanes.size,
      inbound: this.inboundDiagnostics(),
      pairing: {
        enabled: config.pairing !== false,
        ...this.pairing.status(),
      },
      discovery: this.discoveryStatus(),
    }
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
    await this.mailbox.load()
    await this.tasks.load()
    this.durableLoaded = true
  }

  private async activateTransports(recover: boolean): Promise<void> {
    if (this.config.enabled === false) return
    if (this.transports.length === 0) {
      this.log('warn', 'no enabled Telegram or Feishu transport configured; Bot Gateway is installed but idle')
      return
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
      void this.drainCollaboration().catch(error => this.log('warn', `Bot collaboration recovery failed: ${String(error)}`))
    }
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
    if (this.config.collaboration?.enabled !== false) {
      const mentions = parseBotMentions(
        message.text,
        this.directory.ids(),
        this.config.collaboration?.maxGroupBots ?? 6,
      )
      if (mentions.botIds.length) {
        await this.handleCollaborationRequest(message, walId, binding, mentions.botIds, mentions.instruction)
        return
      }
    }
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

  private async handleCollaborationRequest(
    message: InboundMessage,
    walId: string,
    binding: ChatBinding,
    botIds: readonly string[],
    instruction: string,
  ): Promise<void> {
    const validBots = botIds.filter(botId => this.directory.get(botId)?.enabled)
    if (!validBots.length) return
    try {
      const claimed = await this.wal.claim(walId, binding.sessionId)
      if (!claimed) return
      const from = `user:${message.target.platform}:${message.target.userId ?? message.target.chatId}`
      const task = await this.tasks.createTask({
        title: instruction,
        instruction,
        createdBy: from,
        assignedTo: validBots[0]!,
        acceptanceCriteria: [],
        priority: 50,
      })
      let roomId: string | undefined
      let roomEpoch: number | undefined
      let assignedBot = validBots[0]!
      if (validBots.length > 1) {
        const room = await this.rooms.open(message.target, task.id, validBots)
        roomId = room.id
        roomEpoch = room.epoch
        await this.rooms.append(room.id, from, instruction)
        const first = await this.rooms.reserveNext(room.id)
        if (!first) throw new Error('could not reserve the first Group Room turn')
        assignedBot = first.botId
      }
      const run = await this.tasks.createRun(task.id, assignedBot, 1)
      const transcript = roomId ? await this.rooms.transcript(roomId) : []
      const envelope = createEnvelope({
        from,
        to: assignedBot,
        taskId: task.id,
        runId: run.id,
        attemptId: run.attemptId,
        correlationId: task.id,
        ...(roomId === undefined ? {} : { roomId }),
        ...(roomEpoch === undefined ? {} : { epoch: roomEpoch }),
        payload: {
          instruction,
          acceptanceCriteria: [],
          replyTarget: message.target,
          ...(roomId === undefined ? {} : { transcript }),
        },
      })
      await this.mailbox.enqueue(envelope, `task:${task.id}:run:${run.id}`)
      await this.tasks.audit('message', envelope.id, from, 'message.queued', {
        taskId: task.id,
        to: assignedBot,
        roomId: roomId ?? null,
      }, envelope.correlationId)
      const label = validBots.map(botId => `@${botId}`).join('、')
      await this.sendText(
        message.target,
        roomId === undefined
          ? `已将任务交给 ${label}。任务 ID：${task.id}`
          : `已创建 ${label} 协作房间，最多进行 3 轮协作。任务 ID：${task.id}`,
        `mesh-ack:${message.id}`,
      )
      await this.wal.complete(walId)
      void this.drainCollaboration().catch(error => this.log('warn', `Bot collaboration dispatch failed: ${String(error)}`))
    } catch (error: unknown) {
      await this.handleInboundFailure(
        message,
        walId,
        error,
        false,
        `Bot 协作任务创建失败：${String(error)}`,
        `mesh-error:${message.id}`,
      )
    }
  }

  private async drainCollaboration(): Promise<void> {
    if (this.config.collaboration?.enabled === false || this.stopped || !this.running) return
    if (this.collaborationDrain) return this.collaborationDrain
    const drain = this.runCollaborationLoop().finally(() => {
      if (this.collaborationDrain === drain) this.collaborationDrain = undefined
    })
    this.collaborationDrain = drain
    return drain
  }

  private async runCollaborationLoop(): Promise<void> {
    if (!this.bridge) return
    while (!this.stopped && this.running) {
      const lease = await this.mailbox.claim(
        this.directory.ids(),
        this.collaborationWorkerId,
        new Set(this.activeBotRuns.keys()),
      )
      if (!lease) return
      const bot = this.directory.get(lease.item.envelope.to)
      if (!bot) {
        await this.mailbox.fail(lease, `unknown Bot: ${lease.item.envelope.to}`, false)
        continue
      }
      const acknowledged = await this.mailbox.acknowledge(lease)
      if (!acknowledged) continue
      const runningItem = await this.mailbox.start({ ...lease, item: acknowledged })
      if (!runningItem) continue
      const runningLease: MailboxLease = { ...lease, item: runningItem }
      const task = await this.tasks.task(lease.item.envelope.taskId)
      const run = await this.tasks.startRun(lease.item.envelope.runId) ?? await this.tasks.run(lease.item.envelope.runId)
      if (!task || !run || !['queued', 'running'].includes(run.status)) {
        await this.mailbox.fail(runningLease, 'task or run is unavailable', false)
        continue
      }
      const profile = this.profiles.get(bot.profile)
      if (!profile) {
        await this.mailbox.fail(runningLease, `profile unavailable: ${bot.profile}`, false)
        await this.tasks.failRun(run.id, `profile unavailable: ${bot.profile}`)
        continue
      }
      const internal: InternalRun = {
        runId: run.id,
        botId: bot.id,
        sessionId: bot.canonicalSessionId,
        lease: runningLease,
        envelope: lease.item.envelope,
        texts: [],
      }
      this.internalRuns.set(run.id, internal)
      this.internalRunBySession.set(internal.sessionId, run.id)
      this.activeBotRuns.set(bot.id, run.id)
      try {
        const agent = await this.bridge.resumeOrCreate(
          bot.canonicalSessionId as SessionId,
          profile,
        )
        await this.bridge.followup(agent, this.buildInternalPrompt(bot, task, internal.envelope))
      } catch (error: unknown) {
        await this.finishInternalRun(run.id, undefined, error)
      }
    }
  }

  private buildInternalPrompt(bot: BotDescriptor, task: TaskRecord, envelope: BotMessageEnvelope): string {
    const payload = envelope.payload
    const instruction = typeof payload.instruction === 'string' ? payload.instruction : task.instruction
    const criteria = Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
      : task.acceptanceCriteria
    const transcript = Array.isArray(payload.transcript)
      ? payload.transcript
        .filter((item): item is { from: string; text: string } => (
          Boolean(item) && typeof item === 'object' &&
          typeof (item as { from?: unknown }).from === 'string' &&
          typeof (item as { text?: unknown }).text === 'string'
        ))
        .map(item => `${item.from}: ${item.text}`)
      : []
    return [
      bot.soul ? `[SOUL]\n${bot.soul}` : '',
      '[BotMesh structured task]',
      `botId: ${bot.id}`,
      `taskId: ${task.id}`,
      `runId: ${envelope.runId}`,
      `attemptId: ${envelope.attemptId}`,
      `instruction: ${instruction}`,
      criteria.length ? `acceptanceCriteria:\n${criteria.map(item => '- ' + item).join('\n')}` : '',
      transcript.length ? `roomTranscript:\n${transcript.join('\n')}` : '',
      'Return a useful result for the requester. Do not dispatch another Bot through free-form shell commands; structured handoff is managed by the BotMesh runtime.',
    ].filter(Boolean).join('\n\n')
  }

  private async handleInternalSessionEvent(session: SessionLike, event: unknown, runId: string): Promise<void> {
    const internal = this.internalRuns.get(runId)
    if (!internal) return
    const record = asRecord(event)
    const data = asRecord(record.data)
    if (record.type === 'assistant/message') {
      const message = asRecord(data.message)
      const text = textFromContent(message.content)
      if (text) internal.texts.push(text)
      return
    }
    if (record.type !== 'turn/end') return
    const reason = asRecord(data.reason)
    const kind = String(reason.kind ?? '')
    if (kind === 'error' || kind === 'aborted') {
      await this.finishInternalRun(runId, undefined, kind === 'aborted' ? 'Bot 回合已停止。' : 'Bot 回合失败。')
      return
    }
    await this.finishInternalRun(runId, internal.texts.join('\n').trim() || 'Bot 没有返回文本结果。')
  }

  private async finishInternalRun(runId: string, output?: string, error?: unknown): Promise<void> {
    const internal = this.internalRuns.get(runId)
    if (!internal) return
    const cleanup = (): void => {
      this.internalRuns.delete(runId)
      if (this.internalRunBySession.get(internal.sessionId) === runId) this.internalRunBySession.delete(internal.sessionId)
      if (this.activeBotRuns.get(internal.botId) === runId) this.activeBotRuns.delete(internal.botId)
    }
    if (error !== undefined) {
      const failed = await this.mailbox.fail(internal.lease, error, true)
      if (!failed) {
        await this.tasks.audit('message', internal.envelope.id, internal.botId, 'message.stale_failure', {
          taskId: internal.envelope.taskId,
        }, internal.envelope.correlationId)
        cleanup()
        return
      }
      const retrying = failed?.state === 'queued'
      await this.tasks.failRun(runId, error, !retrying)
      cleanup()
      if (!retrying) {
        const target = this.replyTarget(internal.envelope)
        if (target) await this.sendText(target, `@${internal.botId} 处理失败：${String(error)}`, `mesh-failed:${internal.envelope.taskId}:${runId}`)
      } else {
        this.scheduleCollaborationDrain()
      }
      return
    }
    const completed = await this.mailbox.complete(internal.lease)
    if (!completed) {
      await this.tasks.audit('message', internal.envelope.id, internal.botId, 'message.stale_result', {}, internal.envelope.correlationId)
      cleanup()
      return
    }
    const roomId = internal.envelope.roomId
    const room = roomId === undefined ? undefined : await this.rooms.get(roomId)
    if (roomId !== undefined && (!room || room.closed || (internal.envelope.epoch !== undefined && internal.envelope.epoch !== room.epoch))) {
      await this.tasks.audit('message', internal.envelope.id, internal.botId, 'message.stale_room_result', {
        taskId: internal.envelope.taskId,
        roomId,
        envelopeEpoch: internal.envelope.epoch ?? null,
        roomEpoch: room?.epoch ?? null,
        closed: room?.closed ?? null,
      }, internal.envelope.correlationId)
      await this.tasks.failRun(runId, 'room is closed or the result epoch is stale')
      cleanup()
      return
    }
    const result = (output ?? '').trim() || 'Bot 没有返回文本结果。'
    const target = this.replyTarget(internal.envelope)
    if (target) await this.sendText(target, `@${internal.botId}：\n${result}`, `mesh-response:${internal.envelope.taskId}:${runId}`)
    if (roomId) {
      await this.rooms.append(roomId, internal.botId, result)
      const next = await this.rooms.reserveNext(roomId)
      const currentRun = await this.tasks.run(runId)
      if (next && currentRun) {
        await this.tasks.completeRun(runId, result, false)
        await this.tasks.reassignTask(internal.envelope.taskId, next.botId)
        try {
          await this.enqueueRoomTurn(internal, next.botId, currentRun.attempt + 1)
        } catch (nextError: unknown) {
          await this.rooms.close(roomId)
          await this.tasks.audit('room', roomId, internal.botId, 'room.continuation_failed', { error: String(nextError) }, internal.envelope.correlationId)
        }
      } else {
        await this.rooms.close(roomId)
        await this.tasks.completeRun(runId, result, true)
      }
    } else {
      await this.tasks.completeRun(runId, result, true)
    }
    await this.tasks.audit('message', internal.envelope.id, internal.botId, 'message.completed', {
      taskId: internal.envelope.taskId,
      roomId: roomId ?? null,
    }, internal.envelope.correlationId)
    cleanup()
    void this.drainCollaboration().catch(error => this.log('warn', `Bot collaboration continuation failed: ${String(error)}`))
  }

  private async enqueueRoomTurn(internal: InternalRun, botId: string, attempt: number): Promise<void> {
    const task = await this.tasks.task(internal.envelope.taskId)
    if (!task) throw new Error('room task disappeared: ' + internal.envelope.taskId)
    const run = await this.tasks.createRun(task.id, botId, attempt)
    const transcript = internal.envelope.roomId === undefined
      ? []
      : await this.rooms.transcript(internal.envelope.roomId)
    const room = internal.envelope.roomId === undefined
      ? undefined
      : await this.rooms.get(internal.envelope.roomId)
    if (internal.envelope.roomId !== undefined && (!room || room.closed || (internal.envelope.epoch !== undefined && internal.envelope.epoch !== room.epoch))) {
      throw new Error('room is closed or stale: ' + internal.envelope.roomId)
    }
    const envelope = createEnvelope({
      from: internal.botId,
      to: botId,
      taskId: task.id,
      runId: run.id,
      attemptId: run.attemptId,
      correlationId: internal.envelope.correlationId,
      ...(internal.envelope.roomId === undefined ? {} : { roomId: internal.envelope.roomId }),
      ...(room === undefined ? {} : { epoch: room.epoch }),
      payload: {
        instruction: task.instruction,
        acceptanceCriteria: task.acceptanceCriteria,
        replyTarget: this.replyTarget(internal.envelope),
        transcript,
      },
    })
    await this.mailbox.enqueue(envelope, `task:${task.id}:run:${run.id}`)
    await this.tasks.audit('message', envelope.id, internal.botId, 'message.queued', {
      taskId: task.id,
      to: botId,
      roomId: internal.envelope.roomId ?? null,
    }, envelope.correlationId)
    void this.drainCollaboration().catch(error => this.log('warn', `Bot collaboration room dispatch failed: ${String(error)}`))
  }

  private replyTarget(envelope: BotMessageEnvelope): BotTarget | undefined {
    const value = envelope.payload.replyTarget
    if (value === null || typeof value !== 'object') return undefined
    const target = value as Partial<BotTarget>
    if (typeof target.platform !== 'string' || typeof target.chatId !== 'string') return undefined
    return target as BotTarget
  }

  private scheduleCollaborationDrain(): void {
    if (this.collaborationDrainTimer || this.stopped) return
    this.collaborationDrainTimer = setTimeout(() => {
      this.collaborationDrainTimer = undefined
      void this.drainCollaboration().catch(error => this.log('warn', `Bot collaboration retry failed: ${String(error)}`))
    }, 1_500)
    this.collaborationDrainTimer.unref?.()
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
    if (!['new', 'reset', 'stop', 'status', 'help', 'bots', 'bot', 'model', 'mesh'].includes(name)) return false
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
      const rows = this.directory.list().map(bot => {
        const capabilityText = bot.capabilities.length ? ` [${bot.capabilities.join(', ')}]` : ''
        return `@${bot.id} — ${bot.title}${capabilityText}`
      })
      await this.completeWithText(message, walId, binding, `可用 Bot roster：\n${rows.join('\n')}\n\n使用 @bot-name <任务> 发起协作。`)
      return true
    }
    if (name === 'mesh') {
      const mailbox = await this.mailbox.snapshot()
      const taskSnapshot = await this.tasks.snapshot()
      const active = mailbox.filter(item => item.state === 'queued' || item.state === 'claimed' || item.state === 'acknowledged' || item.state === 'running').length
      await this.completeWithText(message, walId, binding, [
        'BotMesh 状态',
        `Bots: ${this.directory.list().length}`,
        `Mailbox active: ${active}`,
        `Tasks: ${taskSnapshot.tasks.length}`,
        `Runs: ${taskSnapshot.runs.length}`,
        `Handoffs: ${taskSnapshot.handoffs.length}`,
        `Active runs: ${this.activeBotRuns.size}`,
      ].join('\n'))
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

  private async handleSessionEvent(session: SessionLike, event: unknown): Promise<void> {
    const record = asRecord(event)
    const data = asRecord(record.data)
    const id = sessionKey(session.id)
    const internalRunId = this.internalRunBySession.get(id)
    if (internalRunId) {
      await this.handleInternalSessionEvent(session, event, internalRunId)
      return
    }
    const state = this.state.snapshot()
    const target = this.sessionTargets.get(id) ?? state.sessions[id]
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
