import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import { JsonState } from './state.js'
import { stableSessionId } from './harness-bridge.js'
import type {
  AuditRecord,
  BotCollaborationConfig,
  BotDescriptor,
  BotAddress,
  BotMessageEnvelope,
  BotMessageKind,
  BotProfile,
  BotTarget,
  FleetApprovalKind,
  FleetApprovalRecord,
  FleetApprovalStatus,
  FleetPlan,
  FleetWorkflowOutput,
  FleetWorkflowPhase,
  FleetWorkflowRecord,
  FleetWorkflowStatus,
  GroupRoomMessage,
  GroupRoomRecord,
  HandoffRecord,
  HandoffStatus,
  MailboxItem,
  MailboxState,
  RunRecord,
  RunStatus,
  TaskRecord,
  TaskStatus,
} from './types.js'

function now(): number {
  return Date.now()
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
}

function uniqueIds(values: readonly (string | number)[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))]
}

function safeLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value !== undefined && Number.isFinite(value) ? value : fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(selected)))
}

export interface MentionParseResult {
  readonly botIds: readonly string[]
  readonly instruction: string
}

/** Resolve only known Bot IDs; ordinary platform @mentions remain normal text. */
export function parseBotMentions(text: string, knownBotIds: Iterable<string>, maxBots = 6): MentionParseResult {
  const known = new Set([...knownBotIds].map(value => value.toLowerCase()))
  const matches = [...text.matchAll(/@([a-z0-9][a-z0-9_-]{0,63})/giu)]
  const botIds: string[] = []
  for (const match of matches) {
    const id = match[1]?.toLowerCase()
    if (!id || !known.has(id) || botIds.includes(id)) continue
    botIds.push(id)
    if (botIds.length >= maxBots) break
  }
  if (!botIds.length) return { botIds: [], instruction: text.trim() }
  const instruction = text
    .replace(/@([a-z0-9][a-z0-9_-]{0,63})/giu, (whole, id: string) => (
      known.has(id.toLowerCase()) ? '' : whole
    ))
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
  return { botIds, instruction: instruction || '请根据当前上下文协助处理。' }
}

export class BotDirectory {
  private readonly entries = new Map<string, BotDescriptor>()

  public constructor(
    profiles: Iterable<BotProfile> = [],
    private defaultSessionScope: BotDescriptor['sessionScope'] = 'requester',
  ) {
    this.replace(profiles)
  }

  public setDefaultSessionScope(scope: BotDescriptor['sessionScope']): void {
    this.defaultSessionScope = scope
  }

  public replace(profiles: Iterable<BotProfile>): void {
    this.entries.clear()
    for (const profile of profiles) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profile.name)) continue
      this.entries.set(profile.name.toLowerCase(), {
        id: profile.name.toLowerCase(),
        profile: profile.name,
        title: profile.title ?? profile.name,
        ...(profile.description === undefined ? {} : { description: profile.description }),
        capabilities: uniqueStrings(profile.capabilities),
        skills: uniqueStrings(profile.skills),
        ...(profile.soul === undefined ? {} : { soul: profile.soul }),
        fleetRole: profile.fleetRole ?? 'generalist',
        sessionScope: profile.sessionScope ?? this.defaultSessionScope,
        allowedUserIds: uniqueIds(profile.allowedUserIds),
        allowedChatIds: uniqueIds(profile.allowedChatIds),
        approvalRequired: profile.approvalRequired === true,
        canonicalSessionId: String(stableSessionId(`bot:${profile.name}`, profile.name, 0)),
        enabled: profile.enabled !== false,
      })
    }
  }

  public get(id: string): BotDescriptor | undefined {
    const entry = this.entries.get(id.toLowerCase())
    return entry && this.clone(entry)
  }

  public list(): BotDescriptor[] {
    return [...this.entries.values()]
      .filter(entry => entry.enabled)
      .map(entry => this.clone(entry))
  }

  public ids(): string[] {
    return this.list().map(entry => entry.id)
  }

  /** Bot ACL is an additional boundary; an empty Bot ACL inherits gateway authorization. */
  public canInvoke(id: string, target: BotTarget): boolean {
    const bot = this.entries.get(id.toLowerCase())
    if (!bot || !bot.enabled) return false
    if (bot.allowedUserIds.length === 0 && bot.allowedChatIds.length === 0) return true
    return (target.userId !== undefined && bot.allowedUserIds.includes(target.userId)) || bot.allowedChatIds.includes(target.chatId)
  }

  /** Resolve a stable DSH session without leaking one requester's context to another. */
  public sessionIdFor(
    id: string,
    context: { readonly requester: string; readonly target: BotTarget; readonly taskId: string },
  ): string | undefined {
    const bot = this.entries.get(id.toLowerCase())
    if (!bot || !bot.enabled) return undefined
    const suffix = bot.sessionScope === 'shared'
      ? 'shared'
      : bot.sessionScope === 'task'
        ? `task:${context.taskId}`
        : bot.sessionScope === 'chat'
          ? `chat:${context.target.platform}:${context.target.chatId}:${context.target.threadId ?? ''}`
          : `requester:${context.requester}`
    return String(stableSessionId(`bot:${bot.id}:${suffix}`, bot.profile, 0))
  }

  /** Accept only a session derived for this request or the Bot's canonical session. */
  public sessionIdForAddress(
    id: string,
    requestedSessionId: string,
    context: { readonly requester: string; readonly target: BotTarget; readonly taskId: string },
  ): string | undefined {
    const bot = this.entries.get(id.toLowerCase())
    if (!bot || !bot.enabled) return undefined
    const derived = this.sessionIdFor(id, context)
    if (requestedSessionId === bot.canonicalSessionId || requestedSessionId === derived) return requestedSessionId
    return undefined
  }

  private clone(entry: BotDescriptor): BotDescriptor {
    return {
      ...entry,
      capabilities: [...entry.capabilities],
      skills: [...entry.skills],
      allowedUserIds: [...entry.allowedUserIds],
      allowedChatIds: [...entry.allowedChatIds],
    }
  }
}

function plannerTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 2))]
}

/** Deterministic, inspectable Fleet planner; it never grants access to a Bot denied by its ACL. */
export class FleetPlanner {
  public plan(
    instruction: string,
    directory: BotDirectory,
    target: BotTarget,
    maxBots = 6,
  ): FleetPlan {
    const normalizedInstruction = instruction.toLowerCase()
    const terms = plannerTerms(instruction)
    const candidates = directory.list()
      .filter(bot => directory.canInvoke(bot.id, target))
      .map((bot, index) => {
        const labels = [bot.title, bot.description ?? '', ...bot.capabilities, ...bot.skills]
          .map(value => value.toLowerCase().trim())
          .filter(value => value.length >= 2)
        const matched = [...new Set([
          ...terms.filter(term => labels.some(label => label.includes(term))),
          ...labels.filter(label => normalizedInstruction.includes(label)),
        ])]
        const roleBoost = bot.fleetRole === 'worker' ? 2 : bot.fleetRole === 'generalist' ? 1 : 0
        return { bot, index, score: matched.length * 10 + roleBoost, matched }
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
    if (candidates.length === 0) throw new Error('no authorized Fleet Bot is available')

    const limit = safeLimit(maxBots, 6, 1, 6)
    const positivelyMatched = candidates.filter(candidate => candidate.score >= 10)
    const pool = positivelyMatched.length > 0 ? positivelyMatched : candidates
    const rawVerifier = candidates.find(candidate => candidate.bot.fleetRole === 'verifier')
      ?? candidates.find(candidate => candidate.bot.capabilities.some(value => /verify|review|audit|验证|审查|审核/iu.test(value)))
    let synthesizer = candidates.find(candidate => candidate.bot.fleetRole === 'synthesizer')
      ?? candidates.find(candidate => candidate.bot.capabilities.some(value => /synth|summary|write|汇总|总结|写作/iu.test(value)))
      ?? pool[0]!
    if (limit === 1) synthesizer = pool[0]!
    const verifier = limit >= 3 && rawVerifier?.bot.id !== synthesizer.bot.id ? rawVerifier : undefined
    const reserved = new Set([synthesizer.bot.id, ...(verifier === undefined ? [] : [verifier.bot.id])])
    const workerBudget = Math.max(1, Math.min(4, limit - reserved.size))
    const workers = pool
      .filter(candidate => candidate.bot.fleetRole !== 'verifier' && candidate.bot.fleetRole !== 'synthesizer')
      .filter(candidate => !reserved.has(candidate.bot.id))
      .slice(0, workerBudget)
    if (workers.length === 0) {
      const fallback = pool.find(candidate => candidate.bot.id !== verifier?.bot.id) ?? pool[0]!
      workers.push(fallback)
      if (new Set([...workers.map(candidate => candidate.bot.id), ...reserved]).size > limit) synthesizer = fallback
    }
    const reasons: Record<string, readonly string[]> = {}
    for (const candidate of new Set([...workers, ...(verifier ? [verifier] : []), synthesizer])) {
      reasons[candidate.bot.id] = candidate.matched.length
        ? candidate.matched
        : [`role:${candidate.bot.fleetRole}`]
    }
    return {
      workerBotIds: workers.map(candidate => candidate.bot.id),
      ...(verifier === undefined ? {} : { verifierBotId: verifier.bot.id }),
      synthesizerBotId: synthesizer.bot.id,
      reasons,
    }
  }
}

interface MailboxEvent {
  readonly kind: 'enqueued' | 'state'
  readonly item: MailboxItem
}

export interface MailboxLease {
  readonly item: MailboxItem
  readonly leaseId: string
  readonly fencingToken: number
}

function leaseMatches(item: MailboxItem, lease: Pick<MailboxLease, 'leaseId' | 'fencingToken'>): boolean {
  return item.leaseId === lease.leaseId && item.fencingToken === lease.fencingToken
}

/**
 * Durable typed mailbox. A lease ID plus monotonically increasing fencing token
 * prevents a late worker from completing a message after its lease expired.
 */
export class BotMailbox {
  private readonly journal: JsonlJournal<MailboxEvent>
  private readonly items = new Map<string, MailboxItem>()
  private readonly idempotency = new Map<string, string>()
  private loaded = false
  private maxAttempts = 3
  private leaseMs = 120_000
  private retryBaseMs = 1_000
  private retryMaxMs = 60_000

  public constructor(
    file: string,
    config: Pick<BotCollaborationConfig, 'mailboxMaxAttempts' | 'mailboxLeaseMs' | 'mailboxRetryBaseMs' | 'mailboxRetryMaxMs'> = {},
  ) {
    this.journal = new JsonlJournal<MailboxEvent>(file)
    this.configure(config)
  }

  public configure(config: Pick<BotCollaborationConfig, 'mailboxMaxAttempts' | 'mailboxLeaseMs' | 'mailboxRetryBaseMs' | 'mailboxRetryMaxMs'> = {}): void {
    this.maxAttempts = safeLimit(config.mailboxMaxAttempts, 3, 1, 10)
    this.leaseMs = safeLimit(config.mailboxLeaseMs, 120_000, 5_000, 30 * 60_000)
    this.retryBaseMs = safeLimit(config.mailboxRetryBaseMs, 1_000, 50, 60_000)
    this.retryMaxMs = safeLimit(config.mailboxRetryMaxMs, 60_000, this.retryBaseMs, 30 * 60_000)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (!event.item) continue
      this.items.set(event.item.id, event.item)
      this.idempotency.set(event.item.idempotencyKey, event.item.id)
    }
    this.loaded = true
  }

  public async enqueue(
    envelope: BotMessageEnvelope,
    idempotencyKey = envelope.id,
    availableAt = now(),
  ): Promise<MailboxItem> {
    await this.load()
    const existingId = this.idempotency.get(idempotencyKey)
    if (existingId) {
      const existing = this.items.get(existingId)
      if (existing) return { ...existing, envelope: { ...existing.envelope, payload: { ...existing.envelope.payload } } }
    }
    const timestamp = now()
    const item: MailboxItem = {
      id: envelope.id,
      idempotencyKey,
      envelope: { ...envelope, payload: { ...envelope.payload } },
      state: 'queued',
      attempts: 0,
      fencingToken: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: Math.max(timestamp, availableAt),
    }
    this.items.set(item.id, item)
    this.idempotency.set(idempotencyKey, item.id)
    await this.journal.append({ kind: 'enqueued', item })
    return { ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }
  }

  /** Look up an existing delivery before creating another Task/Run. */
  public async getByIdempotencyKey(idempotencyKey: string): Promise<MailboxItem | undefined> {
    await this.load()
    const id = this.idempotency.get(idempotencyKey)
    if (id === undefined) return undefined
    const item = this.items.get(id)
    return item && { ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }
  }

  public async claim(
    targets: readonly string[],
    workerId: string,
    blockedTargets: ReadonlySet<string> = new Set(),
    at = now(),
  ): Promise<MailboxLease | undefined> {
    await this.load()
    await this.recoverExpired(at)
    const targetSet = new Set(targets)
    const candidates = [...this.items.values()]
      .filter(item => targetSet.has(item.envelope.to))
      .filter(item => !blockedTargets.has(item.envelope.to))
      .filter(item => item.state === 'queued' && item.nextAttemptAt <= at)
      .filter(item => item.envelope.expiresAt === undefined || item.envelope.expiresAt > at)
      .sort((a, b) => a.createdAt - b.createdAt)
    const item = candidates[0]
    if (!item) return undefined
    const leaseId = workerId + ':' + randomUUID()
    const claimed: MailboxItem = {
      ...item,
      state: 'claimed',
      attempts: item.attempts + 1,
      fencingToken: item.fencingToken + 1,
      leaseId,
      leaseExpiresAt: at + this.leaseMs,
      updatedAt: at,
    }
    await this.record(claimed)
    return { item: { ...claimed }, leaseId, fencingToken: claimed.fencingToken }
  }

  public async acknowledge(lease: MailboxLease, at = now()): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed'], 'acknowledged', at)
  }

  public async start(lease: MailboxLease, at = now()): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed', 'acknowledged'], 'running', at)
  }

  public async complete(lease: MailboxLease, at = now()): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed', 'acknowledged', 'running'], 'completed', at)
  }

  public async fail(lease: MailboxLease, error: unknown, retry = true, at = now()): Promise<MailboxItem | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    const timestamp = at
    if (!current || !leaseMatches(current, lease) || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= timestamp) return undefined
    if (!['claimed', 'acknowledged', 'running'].includes(current.state)) return undefined
    const exhausted = retry && current.attempts >= this.maxAttempts
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
    const failed: MailboxItem = {
      ...withoutLease,
      state: retry ? (exhausted ? 'dead-letter' : 'queued') : 'failed',
      lastError: String(error),
      updatedAt: timestamp,
      nextAttemptAt: retry && !exhausted ? timestamp + this.backoff(current.attempts) : Number.MAX_SAFE_INTEGER,
    }
    await this.record(failed)
    return { ...failed }
  }

  public async deadLetter(lease: MailboxLease, error: unknown, at = now()): Promise<MailboxItem | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    const timestamp = at
    if (!current || !leaseMatches(current, lease) || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= timestamp) return undefined
    if (!['claimed', 'acknowledged', 'running'].includes(current.state)) return undefined
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
    const failed: MailboxItem = {
      ...withoutLease,
      state: 'dead-letter',
      lastError: String(error),
      updatedAt: timestamp,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    }
    await this.record(failed)
    return { ...failed }
  }

  /** Cancel any queued/in-flight delivery for a Run and advance its fence. */
  public async cancelRun(runId: string, error: unknown, at = now()): Promise<MailboxItem | undefined> {
    await this.load()
    const current = [...this.items.values()].find(item => item.envelope.runId === runId && mailboxStateIsActive(item.state))
    if (!current) return undefined
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
    const cancelled: MailboxItem = {
      ...withoutLease,
      state: 'failed',
      fencingToken: current.fencingToken + 1,
      lastError: String(error),
      updatedAt: at,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    }
    await this.record(cancelled)
    return { ...cancelled, envelope: { ...cancelled.envelope, payload: { ...cancelled.envelope.payload } } }
  }

  /** Extend an in-flight lease while the model is still producing a turn. */
  public async renew(lease: MailboxLease, at = now()): Promise<MailboxLease | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    if (!current || !leaseMatches(current, lease) || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= at) return undefined
    if (!['claimed', 'acknowledged', 'running'].includes(current.state)) return undefined
    const renewed: MailboxItem = { ...current, leaseExpiresAt: at + this.leaseMs, updatedAt: at }
    await this.record(renewed)
    return { item: { ...renewed }, leaseId: lease.leaseId, fencingToken: lease.fencingToken }
  }

  /** Recover leases/TTL after restart and return only the records changed by this pass. */
  public async recoverExpired(at = now()): Promise<MailboxItem[]> {
    await this.load()
    const changed: MailboxItem[] = []
    for (const current of [...this.items.values()]) {
      if (!mailboxStateIsActive(current.state)) continue
      if (current.envelope.expiresAt !== undefined && current.envelope.expiresAt <= at) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
        const expired: MailboxItem = {
          ...withoutLease,
          state: 'dead-letter',
          lastError: 'message TTL expired',
          updatedAt: at,
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
        }
        await this.record(expired)
        changed.push({ ...expired })
        continue
      }
      if (
        (current.state === 'claimed' || current.state === 'acknowledged' || current.state === 'running') &&
        current.leaseExpiresAt !== undefined && current.leaseExpiresAt <= at
      ) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
        const exhausted = current.attempts >= this.maxAttempts
        const recovered: MailboxItem = {
          ...withoutLease,
          state: exhausted ? 'dead-letter' : 'queued',
          lastError: exhausted
            ? 'mailbox lease expired and delivery attempts were exhausted'
            : 'mailbox lease expired; returned to queue',
          updatedAt: at,
          nextAttemptAt: exhausted ? Number.MAX_SAFE_INTEGER : at + this.backoff(current.attempts),
        }
        await this.record(recovered)
        changed.push({ ...recovered })
      }
    }
    return changed
  }

  /** Single-host restart recovery: leases from a previous worker process cannot still be live. */
  public async recoverForeignLeases(workerId: string, at = now()): Promise<MailboxItem[]> {
    await this.load()
    const changed: MailboxItem[] = []
    const ownedPrefix = `${workerId}:`
    for (const current of [...this.items.values()]) {
      if (current.state !== 'claimed' && current.state !== 'acknowledged' && current.state !== 'running') continue
      if (current.leaseId?.startsWith(ownedPrefix)) continue
      const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
      const ttlExpired = current.envelope.expiresAt !== undefined && current.envelope.expiresAt <= at
      const exhausted = current.attempts >= this.maxAttempts
      const recovered: MailboxItem = {
        ...withoutLease,
        state: ttlExpired || exhausted ? 'dead-letter' : 'queued',
        lastError: ttlExpired
          ? 'message TTL expired during restart recovery'
          : exhausted
            ? 'previous worker stopped and delivery attempts were exhausted'
            : 'previous worker stopped; returned to queue during restart recovery',
        updatedAt: at,
        nextAttemptAt: ttlExpired || exhausted ? Number.MAX_SAFE_INTEGER : at,
      }
      await this.record(recovered)
      changed.push({ ...recovered, envelope: { ...recovered.envelope, payload: { ...recovered.envelope.payload } } })
    }
    return changed
  }

  /** Earliest durable wake-up needed for delayed retry, TTL, or lease recovery. */
  public async nextWakeAt(
    targets?: readonly string[],
    blockedTargets: ReadonlySet<string> = new Set(),
    at = now(),
  ): Promise<number | undefined> {
    await this.load()
    const targetSet = targets === undefined ? undefined : new Set(targets)
    let earliest: number | undefined
    for (const item of this.items.values()) {
      if (!mailboxStateIsActive(item.state)) continue
      if (targetSet !== undefined && !targetSet.has(item.envelope.to)) continue
      if (blockedTargets.has(item.envelope.to)) continue
      const times: number[] = []
      if (item.state === 'queued') times.push(item.nextAttemptAt)
      if (item.leaseExpiresAt !== undefined) times.push(item.leaseExpiresAt)
      if (item.envelope.expiresAt !== undefined) times.push(item.envelope.expiresAt)
      for (const value of times) {
        if (value <= at) return at
        earliest = earliest === undefined ? value : Math.min(earliest, value)
      }
    }
    return earliest
  }

  public leaseDurationMs(): number {
    return this.leaseMs
  }

  public deliveryMaxAttempts(): number {
    return this.maxAttempts
  }

  public async get(id: string): Promise<MailboxItem | undefined> {
    await this.load()
    const item = this.items.get(id)
    return item && { ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }
  }

  public async pending(targets?: readonly string[]): Promise<MailboxItem[]> {
    await this.load()
    const targetSet = targets === undefined ? undefined : new Set(targets)
    return [...this.items.values()]
      .filter(item => (targetSet === undefined || targetSet.has(item.envelope.to)) && (item.state === 'queued' || item.state === 'claimed' || item.state === 'acknowledged' || item.state === 'running'))
      .map(item => ({ ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  public async snapshot(): Promise<MailboxItem[]> {
    await this.load()
    return [...this.items.values()].map(item => ({ ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }))
  }

  /** Lightweight dashboard view that never copies normal message payloads. */
  public async dashboardSnapshot(deadLetterLimit = 20): Promise<{
    readonly counts: Readonly<Record<MailboxState, number>>
    readonly deadLetters: readonly MailboxItem[]
  }> {
    await this.load()
    const counts: Record<MailboxState, number> = {
      queued: 0,
      claimed: 0,
      acknowledged: 0,
      running: 0,
      completed: 0,
      failed: 0,
      'dead-letter': 0,
    }
    for (const item of this.items.values()) counts[item.state] += 1
    const deadLetters = [...this.items.values()]
      .filter(item => item.state === 'dead-letter')
      .slice(-Math.max(1, deadLetterLimit))
      .reverse()
      .map(item => ({ ...item, envelope: { ...item.envelope, payload: {} } }))
    return { counts, deadLetters }
  }

  private async transition(
    lease: MailboxLease,
    allowed: readonly MailboxState[],
    state: MailboxState,
    at: number,
  ): Promise<MailboxItem | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    const timestamp = at
    if (!current || !leaseMatches(current, lease) || !allowed.includes(current.state)) return undefined
    if (current.leaseExpiresAt === undefined || current.leaseExpiresAt <= timestamp) return undefined
    const next: MailboxItem = {
      ...current,
      state,
      updatedAt: timestamp,
    }
    await this.record(next)
    return { ...next }
  }

  private async record(item: MailboxItem): Promise<void> {
    this.items.set(item.id, item)
    await this.journal.append({ kind: 'state', item })
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempt - 1))
  }
}

interface TaskEvent {
  readonly kind: 'task' | 'run' | 'handoff' | 'workflow' | 'audit'
  readonly task?: TaskRecord
  readonly run?: RunRecord
  readonly handoff?: HandoffRecord
  readonly workflow?: FleetWorkflowRecord
  readonly audit?: AuditRecord
}

export interface CreateTaskInput {
  readonly title: string
  readonly instruction: string
  readonly createdBy: string
  readonly assignedTo: string
  readonly acceptanceCriteria?: readonly string[]
  readonly priority?: number
  readonly roomId?: string
}

/** Durable Task/Run/Handoff state machine and append-only audit trail. */
export class TaskRunStore {
  private readonly journal: JsonlJournal<TaskEvent>
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly handoffs = new Map<string, HandoffRecord>()
  private readonly workflows = new Map<string, FleetWorkflowRecord>()
  private readonly audits: AuditRecord[] = []
  private readonly workflowTails = new Map<string, Promise<void>>()
  private loaded = false

  public constructor(file: string) {
    this.journal = new JsonlJournal<TaskEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (event.kind === 'task' && event.task) this.tasks.set(event.task.id, event.task)
      if (event.kind === 'run' && event.run) this.runs.set(event.run.id, event.run)
      if (event.kind === 'handoff' && event.handoff) this.handoffs.set(event.handoff.id, event.handoff)
      if (event.kind === 'workflow' && event.workflow) this.workflows.set(event.workflow.id, event.workflow)
      if (event.kind === 'audit' && event.audit) this.audits.push(event.audit)
    }
    this.loaded = true
  }

  public async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    await this.load()
    const timestamp = now()
    const task: TaskRecord = {
      id: 'task_' + randomUUID(),
      title: input.title.slice(0, 240),
      instruction: input.instruction,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo,
      acceptanceCriteria: [...(input.acceptanceCriteria ?? [])].slice(0, 20),
      priority: Math.max(0, Math.min(100, Math.floor(input.priority ?? 50))),
      ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.recordTask(task)
    await this.audit('task', task.id, input.createdBy, 'task.created', { assignedTo: task.assignedTo })
    return { ...task, acceptanceCriteria: [...task.acceptanceCriteria] }
  }

  public async attachRoom(taskId: string, roomId: string, actor = 'botmesh'): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    const next: TaskRecord = { ...task, roomId, updatedAt: now() }
    await this.recordTask(next)
    await this.audit('task', taskId, actor, 'task.room_attached', { roomId }, taskId)
    return { ...next, acceptanceCriteria: [...next.acceptanceCriteria] }
  }

  public async createRun(
    taskId: string,
    botId: string,
    attempt: number,
    context: { readonly workflowId?: string; readonly phase?: FleetWorkflowPhase; readonly parentRunId?: string } = {},
  ): Promise<RunRecord> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('task not found: ' + taskId)
    const timestamp = now()
    const run: RunRecord = {
      id: 'run_' + randomUUID(),
      taskId,
      botId,
      attemptId: 'attempt_' + randomUUID(),
      attempt,
      ...(context.workflowId === undefined ? {} : { workflowId: context.workflowId }),
      ...(context.phase === undefined ? {} : { phase: context.phase }),
      ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.recordRun(run)
    await this.recordTask({ ...task, currentRunId: run.id, updatedAt: timestamp })
    await this.audit('run', run.id, botId, 'run.created', { taskId, attempt })
    if (context.workflowId !== undefined) await this.addWorkflowRun(context.workflowId, run.id)
    return { ...run }
  }

  public async startRun(runId: string): Promise<RunRecord | undefined> {
    await this.load()
    const run = this.runs.get(runId)
    if (run?.status === 'running') return { ...run }
    if (!run || run.status !== 'queued') return undefined
    const timestamp = now()
    const next: RunRecord = { ...run, status: 'running', updatedAt: timestamp }
    await this.recordRun(next)
    const task = this.tasks.get(run.taskId)
    if (task) {
      const { error: _error, ...withoutError } = task
      await this.recordTask({ ...withoutError, status: 'running', currentRunId: runId, updatedAt: timestamp })
    }
    await this.audit('run', runId, run.botId, 'run.started', { taskId: run.taskId })
    return { ...next }
  }

  public async completeRun(runId: string, output: string, completeTask = true): Promise<RunRecord | undefined> {
    await this.load()
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running'].includes(run.status)) return undefined
    const timestamp = now()
    const next: RunRecord = { ...run, status: 'completed', output, updatedAt: timestamp }
    await this.recordRun(next)
    const task = this.tasks.get(run.taskId)
    if (task) {
      const activeSibling = [...this.runs.values()].find(candidate => (
        candidate.taskId === run.taskId && candidate.id !== runId && (candidate.status === 'queued' || candidate.status === 'running')
      ))
      const { error: _error, ...withoutError } = task
      await this.recordTask({
        ...(completeTask ? withoutError : task),
        status: completeTask ? 'completed' : activeSibling ? 'running' : 'waiting',
        ...(completeTask ? { result: output } : {}),
        currentRunId: activeSibling?.id ?? runId,
        updatedAt: timestamp,
      })
    }
    await this.audit('run', runId, run.botId, 'run.completed', { taskId: run.taskId, completeTask })
    return { ...next }
  }

  public async failRun(runId: string, error: unknown, failTask = true): Promise<RunRecord | undefined> {
    await this.load()
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running'].includes(run.status)) return undefined
    const timestamp = now()
    const detail = String(error)
    const next: RunRecord = { ...run, status: 'failed', error: detail, updatedAt: timestamp }
    await this.recordRun(next)
    const task = this.tasks.get(run.taskId)
    if (task) {
      const activeSibling = [...this.runs.values()].find(candidate => (
        candidate.taskId === run.taskId && candidate.id !== runId && (candidate.status === 'queued' || candidate.status === 'running')
      ))
      await this.recordTask({
        ...task,
        status: failTask ? 'failed' : activeSibling ? 'running' : 'waiting',
        ...(activeSibling === undefined ? {} : { currentRunId: activeSibling.id }),
        error: detail,
        updatedAt: timestamp,
      })
    }
    await this.audit('run', runId, run.botId, 'run.failed', { taskId: run.taskId, error: detail.slice(0, 500) })
    return { ...next }
  }

  public async cancelRun(runId: string, reason: string, actor = 'botfleet'): Promise<RunRecord | undefined> {
    await this.load()
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running'].includes(run.status)) return undefined
    const timestamp = now()
    const next: RunRecord = { ...run, status: 'cancelled', error: reason, updatedAt: timestamp }
    await this.recordRun(next)
    const task = this.tasks.get(run.taskId)
    if (task && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
      const activeSibling = [...this.runs.values()].find(candidate => (
        candidate.taskId === run.taskId && candidate.id !== runId && (candidate.status === 'queued' || candidate.status === 'running')
      ))
      await this.recordTask({
        ...task,
        status: activeSibling ? 'running' : 'waiting',
        ...(activeSibling === undefined ? {} : { currentRunId: activeSibling.id }),
        updatedAt: timestamp,
      })
    }
    await this.audit('run', runId, actor, 'run.cancelled', { taskId: run.taskId, reason: reason.slice(0, 500) })
    return { ...next }
  }

  public async reassignTask(taskId: string, assignedTo: string): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'cancelled') return undefined
    const next: TaskRecord = { ...task, assignedTo, status: 'waiting', updatedAt: now() }
    await this.recordTask(next)
    await this.audit('task', taskId, assignedTo, 'task.reassigned', { assignedTo })
    return { ...next, acceptanceCriteria: [...next.acceptanceCriteria] }
  }

  public async completeTask(taskId: string, result: string, actor = 'botfleet'): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'cancelled') return undefined
    const { error: _error, ...withoutError } = task
    const next: TaskRecord = { ...withoutError, status: 'completed', result, updatedAt: now() }
    await this.recordTask(next)
    await this.audit('task', taskId, actor, 'task.completed', {}, taskId)
    return { ...next, acceptanceCriteria: [...next.acceptanceCriteria] }
  }

  public async failTask(taskId: string, error: unknown, actor = 'botfleet'): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'cancelled') return undefined
    const detail = String(error)
    const next: TaskRecord = { ...task, status: 'failed', error: detail, updatedAt: now() }
    await this.recordTask(next)
    await this.audit('task', taskId, actor, 'task.failed', { error: detail.slice(0, 500) }, taskId)
    return { ...next, acceptanceCriteria: [...next.acceptanceCriteria] }
  }

  public async cancelTask(taskId: string, actor: string): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return undefined
    const next: TaskRecord = { ...task, status: 'cancelled', updatedAt: now() }
    await this.recordTask(next)
    await this.audit('task', taskId, actor, 'task.cancelled', {}, taskId)
    return { ...next, acceptanceCriteria: [...next.acceptanceCriteria] }
  }

  public async createHandoff(
    taskId: string,
    runId: string,
    fromBot: string,
    toBot: string,
    reason: string,
    replyTarget: BotTarget,
    status: HandoffStatus = 'requested',
    approvalId?: string,
  ): Promise<HandoffRecord> {
    const timestamp = now()
    const handoff: HandoffRecord = {
      id: 'handoff_' + randomUUID(),
      taskId,
      runId,
      fromBot,
      toBot,
      reason: reason.slice(0, 2_000),
      replyTarget: { ...replyTarget },
      ...(approvalId === undefined ? {} : { approvalId }),
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.load()
    this.handoffs.set(handoff.id, handoff)
    await this.journal.append({ kind: 'handoff', handoff })
    await this.audit('handoff', handoff.id, fromBot, 'handoff.' + status, { taskId, toBot })
    return { ...handoff, replyTarget: { ...handoff.replyTarget } }
  }

  public async setHandoffApproval(id: string, approvalId: string): Promise<HandoffRecord | undefined> {
    await this.load()
    const current = this.handoffs.get(id)
    if (!current || current.status !== 'requested') return undefined
    const next: HandoffRecord = { ...current, approvalId, updatedAt: now() }
    this.handoffs.set(id, next)
    await this.journal.append({ kind: 'handoff', handoff: next })
    return { ...next, replyTarget: { ...next.replyTarget } }
  }

  public async updateHandoff(id: string, status: HandoffStatus, actor: string): Promise<HandoffRecord | undefined> {
    await this.load()
    const current = this.handoffs.get(id)
    if (!current || current.status === 'completed' || current.status === 'rejected') return undefined
    const allowed = current.status === 'requested'
      ? status === 'accepted' || status === 'rejected'
      : current.status === 'accepted' && (status === 'completed' || status === 'rejected')
    if (!allowed) return undefined
    const next: HandoffRecord = { ...current, status, updatedAt: now() }
    this.handoffs.set(id, next)
    await this.journal.append({ kind: 'handoff', handoff: next })
    await this.audit('handoff', id, actor, 'handoff.' + status, { taskId: current.taskId, toBot: current.toBot })
    return { ...next, replyTarget: { ...next.replyTarget } }
  }

  public async createWorkflow(input: {
    readonly taskId: string
    readonly createdBy: string
    readonly instruction: string
    readonly replyTarget: BotTarget
    readonly workerBotIds: readonly string[]
    readonly verifierBotId?: string
    readonly synthesizerBotId: string
    readonly planReasons?: Readonly<Record<string, readonly string[]>>
    readonly status?: FleetWorkflowStatus
    readonly approvalId?: string
  }): Promise<FleetWorkflowRecord> {
    await this.load()
    if (!this.tasks.has(input.taskId)) throw new Error('task not found: ' + input.taskId)
    const timestamp = now()
    const workflow: FleetWorkflowRecord = {
      id: 'workflow_' + randomUUID(),
      taskId: input.taskId,
      createdBy: input.createdBy,
      instruction: input.instruction,
      replyTarget: { ...input.replyTarget },
      workerBotIds: [...new Set(input.workerBotIds)],
      ...(input.verifierBotId === undefined ? {} : { verifierBotId: input.verifierBotId }),
      synthesizerBotId: input.synthesizerBotId,
      planReasons: Object.fromEntries(Object.entries(input.planReasons ?? {}).map(([botId, reasons]) => [botId, [...reasons]])),
      status: input.status ?? 'running',
      runIds: [],
      outputs: [],
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.recordWorkflow(workflow)
    await this.audit('workflow', workflow.id, input.createdBy, 'workflow.created', {
      taskId: input.taskId,
      workers: [...workflow.workerBotIds],
      verifier: workflow.verifierBotId ?? null,
      synthesizer: workflow.synthesizerBotId,
    }, workflow.id)
    return this.cloneWorkflow(workflow)
  }

  public async setWorkflowApproval(workflowId: string, approvalId: string): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    return this.withWorkflowLock(workflowId, async () => {
      const current = this.workflows.get(workflowId)
      if (!current || current.status !== 'pending-approval') return undefined
      const next: FleetWorkflowRecord = { ...current, approvalId, updatedAt: now() }
      await this.recordWorkflow(next)
      return this.cloneWorkflow(next)
    })
  }

  public async transitionWorkflow(
    workflowId: string,
    status: FleetWorkflowStatus,
    actor: string,
    detail: { readonly result?: string; readonly error?: string } = {},
  ): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    const next = await this.withWorkflowLock(workflowId, async () => {
      const current = this.workflows.get(workflowId)
      if (!current) return undefined
      if (current.status === status) return this.cloneWorkflow(current)
      const allowed: Readonly<Record<FleetWorkflowStatus, readonly FleetWorkflowStatus[]>> = {
        'pending-approval': ['running', 'failed', 'cancelled'],
        running: ['verifying', 'synthesizing', 'completed', 'failed', 'cancelled'],
        verifying: ['synthesizing', 'failed', 'cancelled'],
        synthesizing: ['completed', 'failed', 'cancelled'],
        completed: [],
        failed: [],
        cancelled: [],
      }
      if (!allowed[current.status].includes(status)) return undefined
      const updated: FleetWorkflowRecord = {
        ...current,
        status,
        ...(detail.result === undefined ? {} : { result: detail.result }),
        ...(detail.error === undefined ? {} : { error: detail.error }),
        updatedAt: now(),
      }
      await this.recordWorkflow(updated)
      return this.cloneWorkflow(updated)
    })
    if (next !== undefined) await this.audit('workflow', workflowId, actor, 'workflow.' + status, { taskId: next.taskId }, workflowId)
    return next
  }

  public async addWorkflowRun(workflowId: string, runId: string): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    return this.withWorkflowLock(workflowId, async () => {
      const current = this.workflows.get(workflowId)
      if (!current) return undefined
      if (current.runIds.includes(runId)) return this.cloneWorkflow(current)
      const next: FleetWorkflowRecord = { ...current, runIds: [...current.runIds, runId], updatedAt: now() }
      await this.recordWorkflow(next)
      return this.cloneWorkflow(next)
    })
  }

  public async recordWorkflowOutput(
    workflowId: string,
    output: Omit<FleetWorkflowOutput, 'at'> & { readonly at?: number },
  ): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    return this.withWorkflowLock(workflowId, async () => {
      const current = this.workflows.get(workflowId)
      if (!current) return undefined
      if (current.outputs.some(item => item.runId === output.runId)) return this.cloneWorkflow(current)
      const next: FleetWorkflowRecord = {
        ...current,
        outputs: [...current.outputs, { ...output, at: output.at ?? now() }],
        updatedAt: now(),
      }
      await this.recordWorkflow(next)
      return this.cloneWorkflow(next)
    })
  }

  public async audit(
    entityType: AuditRecord['entityType'],
    entityId: string,
    actor: string,
    action: string,
    data?: Record<string, unknown>,
    correlationId?: string,
  ): Promise<AuditRecord> {
    await this.load()
    const record: AuditRecord = {
      id: 'audit_' + randomUUID(),
      at: now(),
      actor,
      action,
      entityType,
      entityId,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(data === undefined ? {} : { data: { ...data } }),
    }
    this.audits.push(record)
    await this.journal.append({ kind: 'audit', audit: record })
    return { ...record, ...(record.data === undefined ? {} : { data: { ...record.data } }) }
  }

  public async task(id: string): Promise<TaskRecord | undefined> {
    await this.load()
    const task = this.tasks.get(id)
    return task && { ...task, acceptanceCriteria: [...task.acceptanceCriteria] }
  }

  public async run(id: string): Promise<RunRecord | undefined> {
    await this.load()
    const run = this.runs.get(id)
    return run && { ...run }
  }

  public async workflow(id: string): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    const workflow = this.workflows.get(id)
    return workflow && this.cloneWorkflow(workflow)
  }

  public async workflowForTask(taskId: string): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    const workflow = [...this.workflows.values()].find(candidate => candidate.taskId === taskId)
    return workflow && this.cloneWorkflow(workflow)
  }

  public async handoff(id: string): Promise<HandoffRecord | undefined> {
    await this.load()
    const handoff = this.handoffs.get(id)
    return handoff && { ...handoff, replyTarget: { ...handoff.replyTarget } }
  }

  public async workflowForRun(runId: string): Promise<FleetWorkflowRecord | undefined> {
    await this.load()
    const run = this.runs.get(runId)
    if (run?.workflowId === undefined) return undefined
    const workflow = this.workflows.get(run.workflowId)
    return workflow && this.cloneWorkflow(workflow)
  }

  public async runsForWorkflow(workflowId: string, phase?: FleetWorkflowPhase): Promise<RunRecord[]> {
    await this.load()
    return [...this.runs.values()]
      .filter(run => run.workflowId === workflowId && (phase === undefined || run.phase === phase))
      .map(run => ({ ...run }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  public async snapshot(): Promise<{
    readonly tasks: readonly TaskRecord[]
    readonly runs: readonly RunRecord[]
    readonly handoffs: readonly HandoffRecord[]
    readonly workflows: readonly FleetWorkflowRecord[]
    readonly audits: readonly AuditRecord[]
  }> {
    await this.load()
    return {
      tasks: [...this.tasks.values()].map(task => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria] })),
      runs: [...this.runs.values()],
      handoffs: [...this.handoffs.values()].map(handoff => ({ ...handoff, replyTarget: { ...handoff.replyTarget } })),
      workflows: [...this.workflows.values()].map(workflow => this.cloneWorkflow(workflow)),
      audits: this.audits.map(audit => ({ ...audit, ...(audit.data === undefined ? {} : { data: { ...audit.data } }) })),
    }
  }

  /** Bounded, body-free status projection for the two-second local UI poll. */
  public async dashboardSnapshot(): Promise<{
    readonly tasks: readonly Pick<TaskRecord, 'id' | 'title' | 'status' | 'assignedTo' | 'updatedAt'>[]
    readonly runs: readonly Pick<RunRecord, 'id' | 'taskId' | 'botId' | 'attempt' | 'status' | 'workflowId' | 'phase' | 'error' | 'updatedAt'>[]
    readonly handoffs: readonly Pick<HandoffRecord, 'id' | 'taskId' | 'fromBot' | 'toBot' | 'reason' | 'status' | 'updatedAt'>[]
    readonly workflows: ReadonlyArray<Pick<FleetWorkflowRecord, 'id' | 'taskId' | 'status' | 'workerBotIds' | 'verifierBotId' | 'synthesizerBotId' | 'planReasons' | 'updatedAt'> & { readonly outputCount: number }>
  }> {
    await this.load()
    return {
      tasks: [...this.tasks.values()].slice(-50).reverse().map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assignedTo: task.assignedTo,
        updatedAt: task.updatedAt,
      })),
      runs: [...this.runs.values()].slice(-100).reverse().map(run => ({
        id: run.id,
        taskId: run.taskId,
        botId: run.botId,
        attempt: run.attempt,
        status: run.status,
        ...(run.workflowId === undefined ? {} : { workflowId: run.workflowId }),
        ...(run.phase === undefined ? {} : { phase: run.phase }),
        ...(run.error === undefined ? {} : { error: run.error.slice(0, 500) }),
        updatedAt: run.updatedAt,
      })),
      handoffs: [...this.handoffs.values()].slice(-50).reverse().map(handoff => ({
        id: handoff.id,
        taskId: handoff.taskId,
        fromBot: handoff.fromBot,
        toBot: handoff.toBot,
        reason: handoff.reason,
        status: handoff.status,
        updatedAt: handoff.updatedAt,
      })),
      workflows: [...this.workflows.values()].slice(-50).reverse().map(workflow => ({
        id: workflow.id,
        taskId: workflow.taskId,
        status: workflow.status,
        workerBotIds: [...workflow.workerBotIds],
        ...(workflow.verifierBotId === undefined ? {} : { verifierBotId: workflow.verifierBotId }),
        synthesizerBotId: workflow.synthesizerBotId,
        planReasons: Object.fromEntries(Object.entries(workflow.planReasons ?? {}).map(([botId, reasons]) => [botId, [...reasons]])),
        outputCount: workflow.outputs.length,
        updatedAt: workflow.updatedAt,
      })),
    }
  }

  private async recordTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, task)
    await this.journal.append({ kind: 'task', task })
  }

  private async recordRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, run)
    await this.journal.append({ kind: 'run', run })
  }

  private async recordWorkflow(workflow: FleetWorkflowRecord): Promise<void> {
    this.workflows.set(workflow.id, workflow)
    await this.journal.append({ kind: 'workflow', workflow })
  }

  private async withWorkflowLock<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workflowTails.get(workflowId) ?? Promise.resolve()
    let result!: T
    const current = previous
      .catch(() => undefined)
      .then(async () => { result = await operation() })
      .finally(() => {
        if (this.workflowTails.get(workflowId) === current) this.workflowTails.delete(workflowId)
      })
    this.workflowTails.set(workflowId, current)
    await current
    return result
  }

  private cloneWorkflow(workflow: FleetWorkflowRecord): FleetWorkflowRecord {
    return {
      ...workflow,
      replyTarget: { ...workflow.replyTarget },
      planReasons: Object.fromEntries(Object.entries(workflow.planReasons ?? {}).map(([botId, reasons]) => [botId, [...reasons]])),
      workerBotIds: [...workflow.workerBotIds],
      runIds: [...workflow.runIds],
      outputs: workflow.outputs.map(output => ({ ...output })),
    }
  }
}

interface ApprovalStateFile {
  readonly version: 1
  readonly approvals: Record<string, FleetApprovalRecord>
}

function emptyApprovals(): ApprovalStateFile {
  return { version: 1, approvals: {} }
}

/** Durable human gate shared by chat commands and the local Fleet dashboard. */
export class FleetApprovalStore {
  private readonly state: JsonState<ApprovalStateFile>
  private defaultTtlMs: number

  public constructor(file: string, defaultTtlMs = 30 * 60_000) {
    this.state = new JsonState<ApprovalStateFile>(file, emptyApprovals())
    this.defaultTtlMs = defaultTtlMs
  }

  public configure(defaultTtlMs = 30 * 60_000): void {
    this.defaultTtlMs = defaultTtlMs
  }

  public async create(input: {
    readonly kind: FleetApprovalKind
    readonly requestedBy: string
    readonly summary: string
    readonly entityId: string
    readonly ttlMs?: number
  }): Promise<FleetApprovalRecord> {
    const timestamp = now()
    const ttl = safeLimit(input.ttlMs, this.defaultTtlMs, 60_000, 24 * 60 * 60_000)
    let record: FleetApprovalRecord | undefined
    await this.state.update(current => {
      let code = randomUUID().replace(/-/gu, '').slice(0, 8).toUpperCase()
      const codes = new Set(Object.values(current.approvals).map(item => item.code))
      while (codes.has(code)) code = randomUUID().replace(/-/gu, '').slice(0, 8).toUpperCase()
      record = {
        id: 'approval_' + randomUUID(),
        code,
        kind: input.kind,
        requestedBy: input.requestedBy,
        summary: input.summary.slice(0, 2_000),
        entityId: input.entityId,
        status: 'pending',
        createdAt: timestamp,
        expiresAt: timestamp + ttl,
      }
      current.approvals[record.id] = record
      return current
    })
    return { ...record! }
  }

  public async resolveByCode(
    code: string,
    status: Extract<FleetApprovalStatus, 'approved' | 'rejected'>,
    actor: string,
    at = now(),
  ): Promise<FleetApprovalRecord | undefined> {
    const normalized = code.trim().toUpperCase()
    let result: FleetApprovalRecord | undefined
    await this.state.update(current => {
      const approval = Object.values(current.approvals).find(item => item.code === normalized)
      if (!approval || approval.status !== 'pending') return current
      if (approval.expiresAt > at && actor !== approval.requestedBy && actor !== 'local-dashboard' && actor !== 'local-admin') return current
      const next: FleetApprovalRecord = approval.expiresAt <= at
        ? { ...approval, status: 'expired', resolvedAt: at, resolvedBy: 'system' }
        : { ...approval, status, resolvedAt: at, resolvedBy: actor }
      current.approvals[approval.id] = next
      result = next
      return current
    })
    return result && { ...result }
  }

  public async get(id: string, at = now()): Promise<FleetApprovalRecord | undefined> {
    await this.expire(at)
    const approval = (await this.state.load()).approvals[id]
    return approval && { ...approval }
  }

  public async pending(at = now()): Promise<FleetApprovalRecord[]> {
    await this.expire(at)
    return Object.values((await this.state.load()).approvals)
      .filter(item => item.status === 'pending')
      .map(item => ({ ...item }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  public async snapshot(at = now()): Promise<FleetApprovalRecord[]> {
    await this.expire(at)
    return Object.values((await this.state.load()).approvals)
      .map(item => ({ ...item }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Resolve every still-pending gate for one entity without invoking gateway side effects. */
  public async rejectEntity(entityId: string, actor: string, at = now()): Promise<FleetApprovalRecord[]> {
    const rejected: FleetApprovalRecord[] = []
    await this.state.update(current => {
      for (const [id, approval] of Object.entries(current.approvals)) {
        if (approval.entityId !== entityId || approval.status !== 'pending') continue
        const next: FleetApprovalRecord = {
          ...approval,
          status: approval.expiresAt <= at ? 'expired' : 'rejected',
          resolvedAt: at,
          resolvedBy: approval.expiresAt <= at ? 'system' : actor,
        }
        current.approvals[id] = next
        rejected.push(next)
      }
      return current
    })
    return rejected.map(record => ({ ...record }))
  }

  public async expire(at = now()): Promise<number> {
    const currentSnapshot = await this.state.load()
    if (!Object.values(currentSnapshot.approvals).some(approval => approval.status === 'pending' && approval.expiresAt <= at)) return 0
    let count = 0
    await this.state.update(current => {
      for (const [id, approval] of Object.entries(current.approvals)) {
        if (approval.status !== 'pending' || approval.expiresAt > at) continue
        current.approvals[id] = { ...approval, status: 'expired', resolvedAt: at, resolvedBy: 'system' }
        count += 1
      }
      return current
    })
    return count
  }
}

interface RoomStateFile {
  readonly version: 1
  readonly rooms: Record<string, GroupRoomRecord>
}

function emptyRooms(): RoomStateFile {
  return { version: 1, rooms: {} }
}

/** Hermes-style bounded Group Room state, persisted separately from messages. */
export class GroupRoomStore {
  private readonly state: JsonState<RoomStateFile>
  private maxBots = 6
  private maxRounds = 3
  private maxMessages = 10

  public constructor(file: string, config: BotCollaborationConfig = {}) {
    this.state = new JsonState<RoomStateFile>(file, emptyRooms())
    this.configure(config)
  }

  public configure(config: BotCollaborationConfig = {}): void {
    this.maxBots = safeLimit(config.maxGroupBots, 6, 2, 6)
    this.maxRounds = safeLimit(config.maxGroupRounds ?? config.maxGroupTurns, 3, 1, 3)
    this.maxMessages = safeLimit(config.maxGroupMessages, 10, 2, 100)
  }

  public async open(target: BotTarget, taskId: string, participants: readonly string[]): Promise<GroupRoomRecord> {
    const selected = [...new Set(participants)].slice(0, this.maxBots)
    if (selected.length < 2) throw new Error('a Group Room needs at least two Bot participants')
    const timestamp = now()
    const room: GroupRoomRecord = {
      id: 'room_' + randomUUID(),
      target,
      participants: selected,
      taskId,
      epoch: 1,
      nextParticipantIndex: 0,
      botTurnCount: 0,
      roundCount: 0,
      messageCount: 0,
      maxRounds: this.maxRounds,
      maxMessages: this.maxMessages,
      messages: [],
      closed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.state.update(current => {
      current.rooms[room.id] = room
      return current
    })
    return this.clone(room)
  }

  public async append(roomId: string, from: string, text: string): Promise<GroupRoomRecord | undefined> {
    const current = await this.get(roomId)
    if (!current || current.closed || current.messageCount >= current.maxMessages) return undefined
    const message: GroupRoomMessage = { id: 'roommsg_' + randomUUID(), from, text, at: now() }
    const next: GroupRoomRecord = {
      ...current,
      messageCount: current.messageCount + 1,
      messages: [...current.messages, message].slice(-current.maxMessages),
      updatedAt: now(),
    }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return this.clone(next)
  }

  public async reserveNext(roomId: string): Promise<{ readonly room: GroupRoomRecord; readonly botId: string } | undefined> {
    const current = await this.get(roomId)
    if (!current || current.closed || current.botTurnCount >= current.maxRounds * current.participants.length || current.messageCount >= current.maxMessages) return undefined
    const botId = current.participants[current.nextParticipantIndex % current.participants.length]
    if (!botId) return undefined
    const next: GroupRoomRecord = {
      ...current,
      nextParticipantIndex: current.nextParticipantIndex + 1,
      botTurnCount: current.botTurnCount + 1,
      roundCount: Math.floor((current.botTurnCount + 1) / current.participants.length),
      updatedAt: now(),
    }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return { room: this.clone(next), botId }
  }

  public async close(roomId: string): Promise<GroupRoomRecord | undefined> {
    const current = await this.get(roomId)
    if (!current) return undefined
    const next: GroupRoomRecord = { ...current, closed: true, updatedAt: now() }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return this.clone(next)
  }

  /** Start a new generation so results from the previous room epoch are fenced out. */
  public async supersede(roomId: string, participants?: readonly string[]): Promise<GroupRoomRecord | undefined> {
    const current = await this.get(roomId)
    if (!current) return undefined
    const selected = participants === undefined
      ? [...current.participants]
      : [...new Set(participants)].slice(0, this.maxBots)
    if (selected.length < 2) throw new Error('a Group Room needs at least two Bot participants')
    const next: GroupRoomRecord = {
      ...current,
      participants: selected,
      epoch: current.epoch + 1,
      nextParticipantIndex: 0,
      botTurnCount: 0,
      roundCount: 0,
      messageCount: 0,
      messages: [],
      closed: false,
      updatedAt: now(),
    }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return this.clone(next)
  }

  public async get(roomId: string): Promise<GroupRoomRecord | undefined> {
    const current = (await this.state.load()).rooms[roomId]
    if (!current) return undefined
    return this.clone(this.normalize(current))
  }

  public async transcript(roomId: string): Promise<readonly GroupRoomMessage[]> {
    return (await this.get(roomId))?.messages ?? []
  }

  public async snapshot(): Promise<readonly GroupRoomRecord[]> {
    const rooms = (await this.state.load()).rooms
    return Object.values(rooms).map(room => this.clone(this.normalize(room)))
  }

  private normalize(room: GroupRoomRecord): GroupRoomRecord {
    const legacyTurns = room.botTurnCount ?? room.turnCount ?? 0
    const legacyMax = room.maxRounds ?? room.maxTurns ?? this.maxRounds
    return {
      ...room,
      botTurnCount: legacyTurns,
      roundCount: room.roundCount ?? Math.floor(legacyTurns / Math.max(1, room.participants.length)),
      maxRounds: legacyMax,
    }
  }

  private clone(room: GroupRoomRecord): GroupRoomRecord {
    return { ...room, participants: [...room.participants], messages: room.messages.map(message => ({ ...message })) }
  }
}

export interface BotRequestInput {
  readonly from: string
  readonly botIds: readonly string[]
  readonly instruction: string
  readonly acceptanceCriteria?: readonly string[]
  readonly replyTarget: BotTarget
  readonly title?: string
}

export function createEnvelope(input: {
  readonly kind?: BotMessageKind
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
  readonly replyTo?: string
  readonly traceId?: string
  readonly hop?: number
  readonly maxHops?: number
  readonly roomId?: string
  readonly epoch?: number
  readonly idempotencyKey?: string
  readonly payload: Record<string, unknown>
  readonly createdAt?: number
  readonly expiresAt?: number
}): BotMessageEnvelope {
  return {
    id: 'msg_' + randomUUID(),
    kind: input.kind ?? 'request',
    from: input.from,
    to: input.to,
    taskId: input.taskId,
    runId: input.runId,
    attemptId: input.attemptId,
    correlationId: input.correlationId,
    ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
    ...(input.fromAddress === undefined ? {} : { fromAddress: { ...input.fromAddress } }),
    ...(input.toAddress === undefined ? {} : { toAddress: { ...input.toAddress } }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.hop === undefined ? {} : { hop: input.hop }),
    ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
    ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    payload: { ...input.payload },
    createdAt: input.createdAt ?? now(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  }
}

export function mailboxStateIsActive(state: MailboxState): boolean {
  return state === 'queued' || state === 'claimed' || state === 'acknowledged' || state === 'running'
}

export function taskStatusIsTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function runStatusIsTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
