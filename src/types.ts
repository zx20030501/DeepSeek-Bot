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
  /** Fleet responsibility used by the deterministic planner. */
  readonly fleetRole?: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  /** Safe default isolates long-term Bot context by requester. */
  readonly sessionScope?: 'requester' | 'chat' | 'shared' | 'task'
  /** Optional Bot-level ACL applied after the gateway allowlist/pairing check. */
  readonly allowedUserIds?: readonly (string | number)[]
  readonly allowedChatIds?: readonly (string | number)[]
  /** Require an explicit Fleet approval even when the requester names this Bot. */
  readonly approvalRequired?: boolean
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
  /** Number of complete participant cycles in a sequential Group Room. */
  readonly maxGroupRounds?: number
  /** @deprecated Alias retained for existing PR #8 configurations. */
  readonly maxGroupTurns?: number
  readonly maxGroupMessages?: number
  readonly mailboxMaxAttempts?: number
  readonly mailboxLeaseMs?: number
  readonly mailboxRetryBaseMs?: number
  readonly mailboxRetryMaxMs?: number
  readonly botRunMaxAttempts?: number
  readonly maxParallelRuns?: number
  readonly defaultSessionScope?: 'requester' | 'chat' | 'shared' | 'task'
  readonly approvalMode?: 'never' | 'auto-planned' | 'multi-bot' | 'always'
  readonly approvalTtlMs?: number
  readonly autoPlanner?: boolean
  /** Default lifetime for internal Peer Messages. */
  readonly peerMessageTtlMs?: number
  /** Maximum forwarding depth for Bot-to-Bot messages. */
  readonly peerMaxHops?: number
  /** Maximum UTF-8 JSON payload size for one Peer Message. */
  readonly peerMaxPayloadBytes?: number
}

export interface BotDescriptor {
  readonly id: string
  readonly profile: string
  readonly title: string
  readonly description?: string
  readonly capabilities: readonly string[]
  readonly skills: readonly string[]
  readonly soul?: string
  readonly fleetRole: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  readonly sessionScope: 'requester' | 'chat' | 'shared' | 'task'
  readonly allowedUserIds: readonly string[]
  readonly allowedChatIds: readonly string[]
  readonly approvalRequired: boolean
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

export type BotAddressType = 'user' | 'bot' | 'system' | 'service'

/** Stable logical address used by the typed BotMesh protocol. */
export interface BotAddress {
  readonly id: string
  readonly type?: BotAddressType
  readonly sessionId?: string
  readonly roomId?: string
  readonly threadId?: string
}

export type PeerMessageKind = 'request' | 'reply' | 'report' | 'event' | 'cancel'
export type BotMessageKind = PeerMessageKind | 'response' | 'handoff'

export interface BotMessageEnvelope {
  readonly id: string
  readonly kind: BotMessageKind
  /** Legacy actor IDs remain the durable compatibility fields. */
  readonly from: string
  readonly to: string
  readonly taskId: string
  readonly runId: string
  readonly attemptId: string
  readonly correlationId: string
  readonly schemaVersion?: 1
  readonly fromAddress?: BotAddress
  readonly toAddress?: BotAddress
  readonly conversationId?: string
  /** Message ID being answered or superseded. */
  readonly replyTo?: string
  /** Trace identity shared by forwarded messages. */
  readonly traceId?: string
  /** Forwarding depth; new messages start at zero. */
  readonly hop?: number
  readonly maxHops?: number
  readonly roomId?: string
  /** Room generation used to reject results from a closed or superseded room. */
  readonly epoch?: number
  /** Explicit key used by callers that need enqueue idempotency. */
  readonly idempotencyKey?: string
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
  readonly workflowId?: string
  readonly phase?: FleetWorkflowPhase
  readonly parentRunId?: string
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
  readonly replyTarget: BotTarget
  readonly approvalId?: string
  readonly status: HandoffStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AuditRecord {
  readonly id: string
  readonly at: number
  readonly actor: string
  readonly action: string
  readonly entityType: 'message' | 'task' | 'run' | 'handoff' | 'room' | 'workflow' | 'approval'
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
  /** Number of individual Bot turns already reserved. */
  readonly botTurnCount: number
  /** Number of complete participant cycles already finished. */
  readonly roundCount: number
  readonly messageCount: number
  readonly maxRounds: number
  /** Legacy PR #8 fields accepted while reading an existing rooms.json. */
  readonly turnCount?: number
  readonly maxTurns?: number
  readonly maxMessages: number
  readonly messages: readonly GroupRoomMessage[]
  readonly closed: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export type FleetWorkflowPhase = 'execute' | 'verify' | 'synthesize'
export type FleetWorkflowStatus =
  | 'pending-approval'
  | 'running'
  | 'verifying'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface FleetWorkflowOutput {
  readonly runId: string
  readonly botId: string
  readonly phase: FleetWorkflowPhase
  readonly text: string
  readonly at: number
}

export interface FleetWorkflowRecord {
  readonly id: string
  readonly taskId: string
  readonly createdBy: string
  readonly instruction: string
  readonly replyTarget: BotTarget
  readonly workerBotIds: readonly string[]
  readonly verifierBotId?: string
  readonly synthesizerBotId: string
  readonly planReasons: Readonly<Record<string, readonly string[]>>
  readonly status: FleetWorkflowStatus
  readonly runIds: readonly string[]
  readonly outputs: readonly FleetWorkflowOutput[]
  readonly approvalId?: string
  readonly result?: string
  readonly error?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type FleetApprovalKind = 'workflow' | 'handoff' | 'bot-invocation'
export type FleetApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface FleetApprovalRecord {
  readonly id: string
  /** Short code suitable for chat commands; the full UUID remains the durable identity. */
  readonly code: string
  readonly kind: FleetApprovalKind
  readonly requestedBy: string
  readonly summary: string
  readonly entityId: string
  readonly status: FleetApprovalStatus
  readonly createdAt: number
  readonly expiresAt: number
  readonly resolvedAt?: number
  readonly resolvedBy?: string
}

export interface FleetPlan {
  readonly workerBotIds: readonly string[]
  readonly verifierBotId?: string
  readonly synthesizerBotId: string
  readonly reasons: Readonly<Record<string, readonly string[]>>
}

export interface SendBotMessageInput {
  readonly from: string
  readonly to: string
  readonly instruction: string
  readonly replyTarget: BotTarget
  readonly title?: string
  readonly acceptanceCriteria?: readonly string[]
  readonly kind?: BotMessageKind
  readonly fromAddress?: BotAddress
  readonly toAddress?: BotAddress
  readonly fromSessionId?: string
  readonly toSessionId?: string
  readonly conversationId?: string
  readonly replyTo?: string
  readonly traceId?: string
  readonly hop?: number
  readonly maxHops?: number
  readonly idempotencyKey?: string
  /** Optional structured context; credential-like fields are rejected at the protocol boundary. */
  readonly payload?: Readonly<Record<string, unknown>>
  readonly correlationId?: string
  readonly ttlMs?: number
  readonly expiresAt?: number
}

export interface HandoffRequestInput {
  readonly taskId: string
  readonly runId: string
  readonly fromBot: string
  readonly toBot: string
  readonly reason: string
  readonly requestedBy: string
  readonly replyTarget: BotTarget
  readonly requireApproval?: boolean
}

/** Bounded on-demand projection; unlike the polling dashboard this may contain task bodies. */
export interface FleetTaskDetail {
  readonly task: TaskRecord
  readonly workflow?: FleetWorkflowRecord
  readonly runs: readonly RunRecord[]
  readonly handoffs: readonly HandoffRecord[]
  readonly audits: readonly AuditRecord[]
  readonly deliveries: ReadonlyArray<Pick<MailboxItem, 'id' | 'state' | 'attempts' | 'fencingToken' | 'lastError' | 'createdAt' | 'updatedAt'> & {
    readonly botId: string
    readonly runId: string
  }>
}

export interface FleetReplayResult {
  readonly sourceTaskId: string
  readonly taskId: string
  readonly workflowId?: string
  readonly approvalCode?: string
  readonly status: 'pending-approval' | 'started'
}

export interface FleetHandoffToolResult {
  readonly status: 'accepted' | 'pending-approval'
  readonly handoffId: string
  readonly toBot: string
  readonly message: string
}
