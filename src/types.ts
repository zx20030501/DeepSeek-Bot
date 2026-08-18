export interface BotTarget {
  readonly platform: string
  readonly chatId: string
  readonly threadId?: string
  /** The platform message to reply to, when the transport supports it. */
  readonly replyToMessageId?: string
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

/** Short-lived, UI-only diagnostic data. Message bodies are never stored here. */
export interface FeishuEventDiagnostic {
  readonly receivedAt: number
  readonly messageId?: string
  readonly userId?: string
  readonly chatId?: string
  readonly chatType?: string
  readonly mentionedBot?: boolean
  readonly textLength: number
  readonly resourceCount: number
  readonly normalized: boolean
  readonly reason: string
}

export interface InboundDecisionDiagnostic {
  readonly receivedAt: number
  readonly platform: string
  readonly messageId: string
  readonly userId?: string
  readonly chatId: string
  readonly chatType?: BotTarget['chatType']
  readonly textLength: number
  readonly decision: 'accepted' | 'unauthorized' | 'duplicate'
  readonly reason: string
}

export interface GatewayInboundDiagnostics {
  readonly received: number
  readonly accepted: number
  readonly unauthorized: number
  readonly duplicate: number
  readonly last: InboundDecisionDiagnostic | null
}

/** Short-lived identity candidate discovered by the one-time bind command. */
export interface GatewayDiscoveryCandidate {
  readonly receivedAt: number
  readonly userId: string
  readonly chatId: string
  readonly chatType?: BotTarget['chatType']
}

export interface GatewayDiscoveryStatus {
  readonly active: boolean
  readonly command?: string
  readonly expiresAt?: number
  readonly candidate?: GatewayDiscoveryCandidate
}

export interface BotProfile {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  readonly enabled?: boolean
  /** Capability labels used by the internal Bot Directory and future planner. */
  readonly capabilities?: readonly string[]
  /** Skill names exposed in roster/status output; execution remains DSH-owned. */
  readonly skills?: readonly string[]
  /** Optional short SOUL-style identity prompt for the canonical Bot Chat. */
  readonly soul?: string
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
  /** Unknown direct-message senders receive a one-time pairing code. */
  readonly pairing?: boolean
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
  readonly collaboration?: BotCollaborationConfig
}

export interface BotCollaborationConfig {
  readonly enabled?: boolean
  readonly maxGroupBots?: number
  readonly maxGroupTurns?: number
  readonly maxGroupMessages?: number
  readonly mailboxMaxAttempts?: number
  readonly mailboxLeaseMs?: number
}

export interface BotDescriptor {
  readonly id: string
  readonly profile: string
  readonly title: string
  readonly description?: string
  readonly capabilities: readonly string[]
  readonly skills: readonly string[]
  readonly soul?: string
  readonly canonicalSessionId: string
  readonly enabled: boolean
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
  readonly modelOverride?: ModelOverride | string
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

export interface ModelOverride {
  readonly provider?: string
  readonly model: string
}

export interface PairingRequest {
  readonly code: string
  readonly platform: string
  readonly userId: string
  readonly chatId: string
  readonly chatType?: BotTarget['chatType']
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastNotifiedAt: number
}

export interface PairingApproval {
  readonly platform: string
  readonly userId: string
  readonly approvedAt: number
}

export type BotMessageKind = 'request' | 'response' | 'handoff' | 'event'

export interface BotMessageEnvelope {
  readonly id: string
  readonly kind: BotMessageKind
  readonly from: string
  readonly to: string
  readonly taskId: string
  readonly runId: string
  readonly attemptId: string
  readonly correlationId: string
  readonly roomId?: string
  /** Room generation used to reject results from a closed or superseded room. */
  readonly epoch?: number
  readonly payload: Record<string, unknown>
  readonly createdAt: number
  readonly expiresAt?: number
}

export type MailboxState = 'queued' | 'claimed' | 'acknowledged' | 'running' | 'completed' | 'failed' | 'dead-letter'

export interface MailboxItem {
  readonly id: string
  readonly idempotencyKey: string
  readonly envelope: BotMessageEnvelope
  readonly state: MailboxState
  readonly attempts: number
  readonly fencingToken: number
  readonly leaseId?: string
  readonly leaseExpiresAt?: number
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly nextAttemptAt: number
}

export type TaskStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord {
  readonly id: string
  readonly title: string
  readonly instruction: string
  readonly createdBy: string
  readonly assignedTo: string
  readonly acceptanceCriteria: readonly string[]
  readonly priority: number
  readonly roomId?: string
  readonly status: TaskStatus
  readonly currentRunId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly result?: string
  readonly error?: string
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunRecord {
  readonly id: string
  readonly taskId: string
  readonly botId: string
  readonly attemptId: string
  readonly attempt: number
  readonly status: RunStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly output?: string
  readonly error?: string
}

export type HandoffStatus = 'requested' | 'accepted' | 'completed' | 'rejected'

export interface HandoffRecord {
  readonly id: string
  readonly taskId: string
  readonly runId: string
  readonly fromBot: string
  readonly toBot: string
  readonly reason: string
  readonly status: HandoffStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AuditRecord {
  readonly id: string
  readonly at: number
  readonly actor: string
  readonly action: string
  readonly entityType: 'message' | 'task' | 'run' | 'handoff' | 'room'
  readonly entityId: string
  readonly correlationId?: string
  readonly data?: Record<string, unknown>
}

export interface GroupRoomMessage {
  readonly id: string
  readonly from: string
  readonly text: string
  readonly at: number
}

export interface GroupRoomRecord {
  readonly id: string
  readonly target: BotTarget
  readonly participants: readonly string[]
  readonly taskId: string
  readonly epoch: number
  readonly nextParticipantIndex: number
  readonly turnCount: number
  readonly messageCount: number
  readonly maxTurns: number
  readonly maxMessages: number
  readonly messages: readonly GroupRoomMessage[]
  readonly closed: boolean
  readonly createdAt: number
  readonly updatedAt: number
}
