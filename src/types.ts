export interface BotTarget {
  readonly platform: string
  readonly chatId: string
  readonly threadId?: string
  readonly userId?: string
  readonly chatType?: 'dm' | 'group' | 'channel' | 'thread'
}

export interface InboundMessage {
  readonly id: string
  readonly updateId?: string
  readonly target: BotTarget
  readonly text: string
  readonly receivedAt: number
  readonly replyToMessageId?: string
  readonly raw?: unknown
}

export interface OutboundTarget extends BotTarget {
  readonly replyToMessageId?: string
}

export interface BotTransport {
  readonly platform: string
  start(handler: (message: InboundMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
  send(target: OutboundTarget, text: string): Promise<void>
  typing?(target: BotTarget): Promise<void>
  status?(): Record<string, unknown>
}

export interface BotProfile {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  readonly enabled?: boolean
}

export interface TelegramConfig {
  readonly enabled?: boolean
  readonly token?: string
  readonly pollTimeoutSeconds?: number
  readonly requestTimeoutMs?: number
  readonly maxAttempts?: number
}

export interface FeishuConfig {
  /** Enable the Feishu/Lark transport. The transport uses the official SDK WebSocket mode. */
  readonly enabled?: boolean
  readonly appId?: string
  readonly appSecret?: string
  readonly domain?: 'feishu' | 'lark'
  /** Group messages must mention the bot by default. */
  readonly requireMention?: boolean
  readonly handshakeTimeoutMs?: number
  readonly maxMessageChars?: number
}

export interface BotAccessConfig {
  /** Secure default: an empty allowlist accepts nobody. */
  readonly mode?: 'allowlist' | 'open'
  readonly userIds?: readonly (string | number)[]
  readonly chatIds?: readonly (string | number)[]
  readonly notifyUnauthorized?: boolean
}

export interface BotGatewayConfig {
  readonly enabled?: boolean
  readonly stateDir?: string
  readonly defaultProfile?: string
  readonly profiles?: Record<string, Omit<BotProfile, 'name'>>
  readonly access?: BotAccessConfig
  readonly telegram?: TelegramConfig
  readonly feishu?: FeishuConfig
  readonly maxInboundAttempts?: number
  readonly outboxMaxAttempts?: number
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
}

export type WalState = 'accepted' | 'dispatched' | 'completed' | 'failed'

export interface WalItem {
  readonly id: string
  readonly state: WalState
  readonly message: InboundMessage
  readonly sessionId?: string
  readonly attempts: number
  readonly lastError?: string
  readonly updatedAt: number
}

export type OutboxState = 'pending' | 'sending' | 'sent' | 'dead'

export interface OutboxItem {
  readonly id: string
  readonly key: string
  readonly state: OutboxState
  readonly target: OutboundTarget
  readonly text: string
  readonly attempts: number
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly nextAttemptAt: number
}

export interface ChatBinding {
  readonly key: string
  readonly target: BotTarget
  readonly profile: string
  readonly generation: number
  readonly sessionId: string
  readonly modelOverride?: string
  readonly updatedAt: number
}

export interface BotStateFile {
  readonly version: 1
  readonly bindings: Record<string, ChatBinding>
  readonly sessions: Record<string, BotTarget>
}

export interface DshAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}
