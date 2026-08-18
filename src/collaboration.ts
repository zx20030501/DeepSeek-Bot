import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import { JsonState } from './state.js'
import { stableSessionId } from './harness-bridge.js'
import type {
  AuditRecord,
  BotCollaborationConfig,
  BotDescriptor,
  BotMessageEnvelope,
  BotMessageKind,
  BotProfile,
  BotTarget,
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

function safeLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)))
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

  public constructor(profiles: Iterable<BotProfile> = []) {
    this.replace(profiles)
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
        canonicalSessionId: String(stableSessionId(`bot:${profile.name}`, profile.name, 0)),
        enabled: profile.enabled !== false,
      })
    }
  }

  public get(id: string): BotDescriptor | undefined {
    const entry = this.entries.get(id.toLowerCase())
    return entry && { ...entry, capabilities: [...entry.capabilities], skills: [...entry.skills] }
  }

  public list(): BotDescriptor[] {
    return [...this.entries.values()]
      .filter(entry => entry.enabled)
      .map(entry => ({ ...entry, capabilities: [...entry.capabilities], skills: [...entry.skills] }))
  }

  public ids(): string[] {
    return this.list().map(entry => entry.id)
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
  private readonly maxAttempts: number
  private readonly leaseMs: number

  public constructor(
    file: string,
    config: Pick<BotCollaborationConfig, 'mailboxMaxAttempts' | 'mailboxLeaseMs'> = {},
  ) {
    this.journal = new JsonlJournal<MailboxEvent>(file)
    this.maxAttempts = safeLimit(config.mailboxMaxAttempts, 3, 1, 10)
    this.leaseMs = safeLimit(config.mailboxLeaseMs, 120_000, 5_000, 30 * 60_000)
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
      nextAttemptAt: timestamp,
    }
    this.items.set(item.id, item)
    this.idempotency.set(idempotencyKey, item.id)
    await this.journal.append({ kind: 'enqueued', item })
    return { ...item, envelope: { ...item.envelope, payload: { ...item.envelope.payload } } }
  }

  public async claim(
    targets: readonly string[],
    workerId: string,
    blockedTargets: ReadonlySet<string> = new Set(),
    at = now(),
  ): Promise<MailboxLease | undefined> {
    await this.load()
    for (const current of this.items.values()) {
      if (
        (current.state === 'claimed' || current.state === 'acknowledged' || current.state === 'running') &&
        current.leaseExpiresAt !== undefined && current.leaseExpiresAt <= at
      ) {
        const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
        await this.record({
          ...withoutLease,
          state: 'queued',
          lastError: 'mailbox lease expired; returned to queue',
          updatedAt: at,
          nextAttemptAt: at,
        })
      }
    }
    const targetSet = new Set(targets)
    const candidates = [...this.items.values()]
      .filter(item => targetSet.has(item.envelope.to))
      .filter(item => !blockedTargets.has(item.envelope.to))
      .filter(item => item.state === 'queued' && item.nextAttemptAt <= at)
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

  public async acknowledge(lease: MailboxLease): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed'], 'acknowledged')
  }

  public async start(lease: MailboxLease): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed', 'acknowledged'], 'running')
  }

  public async complete(lease: MailboxLease): Promise<MailboxItem | undefined> {
    return this.transition(lease, ['claimed', 'acknowledged', 'running'], 'completed')
  }

  public async fail(lease: MailboxLease, error: unknown, retry = true): Promise<MailboxItem | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    if (!current || !leaseMatches(current, lease)) return undefined
    if (!['claimed', 'acknowledged', 'running'].includes(current.state)) return undefined
    const exhausted = !retry || current.attempts >= this.maxAttempts
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = current
    const failed: MailboxItem = {
      ...withoutLease,
      state: exhausted ? 'dead-letter' : 'queued',
      lastError: String(error),
      updatedAt: now(),
      nextAttemptAt: exhausted ? Number.MAX_SAFE_INTEGER : now() + this.backoff(current.attempts),
    }
    await this.record(failed)
    return { ...failed }
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

  private async transition(
    lease: MailboxLease,
    allowed: readonly MailboxState[],
    state: MailboxState,
  ): Promise<MailboxItem | undefined> {
    await this.load()
    const current = this.items.get(lease.item.id)
    if (!current || !leaseMatches(current, lease) || !allowed.includes(current.state)) return undefined
    const next: MailboxItem = {
      ...current,
      state,
      updatedAt: now(),
    }
    await this.record(next)
    return { ...next }
  }

  private async record(item: MailboxItem): Promise<void> {
    this.items.set(item.id, item)
    await this.journal.append({ kind: 'state', item })
  }

  private backoff(attempt: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1))
  }
}

interface TaskEvent {
  readonly kind: 'task' | 'run' | 'handoff' | 'audit'
  readonly task?: TaskRecord
  readonly run?: RunRecord
  readonly handoff?: HandoffRecord
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
  private readonly audits: AuditRecord[] = []
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

  public async createRun(taskId: string, botId: string, attempt: number): Promise<RunRecord> {
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
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.recordRun(run)
    await this.recordTask({ ...task, currentRunId: run.id, updatedAt: timestamp })
    await this.audit('run', run.id, botId, 'run.created', { taskId, attempt })
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
    if (task) await this.recordTask({ ...task, status: 'running', currentRunId: runId, updatedAt: timestamp })
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
      await this.recordTask({
        ...task,
        status: completeTask ? 'completed' : 'waiting',
        ...(completeTask ? { result: output } : {}),
        currentRunId: runId,
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
    if (task) await this.recordTask({ ...task, status: failTask ? 'failed' : 'waiting', error: detail, updatedAt: timestamp })
    await this.audit('run', runId, run.botId, 'run.failed', { taskId: run.taskId, error: detail.slice(0, 500) })
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

  public async createHandoff(
    taskId: string,
    runId: string,
    fromBot: string,
    toBot: string,
    reason: string,
    status: HandoffStatus = 'requested',
  ): Promise<HandoffRecord> {
    const timestamp = now()
    const handoff: HandoffRecord = {
      id: 'handoff_' + randomUUID(),
      taskId,
      runId,
      fromBot,
      toBot,
      reason: reason.slice(0, 2_000),
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.load()
    this.handoffs.set(handoff.id, handoff)
    await this.journal.append({ kind: 'handoff', handoff })
    await this.audit('handoff', handoff.id, fromBot, 'handoff.' + status, { taskId, toBot })
    return { ...handoff }
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

  public async snapshot(): Promise<{
    readonly tasks: readonly TaskRecord[]
    readonly runs: readonly RunRecord[]
    readonly handoffs: readonly HandoffRecord[]
    readonly audits: readonly AuditRecord[]
  }> {
    await this.load()
    return {
      tasks: [...this.tasks.values()].map(task => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria] })),
      runs: [...this.runs.values()],
      handoffs: [...this.handoffs.values()],
      audits: this.audits.map(audit => ({ ...audit, ...(audit.data === undefined ? {} : { data: { ...audit.data } }) })),
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
  private readonly maxBots: number
  private readonly maxTurns: number
  private readonly maxMessages: number

  public constructor(file: string, config: BotCollaborationConfig = {}) {
    this.state = new JsonState<RoomStateFile>(file, emptyRooms())
    this.maxBots = safeLimit(config.maxGroupBots, 6, 2, 6)
    this.maxTurns = safeLimit(config.maxGroupTurns, 3, 1, 3)
    this.maxMessages = safeLimit(config.maxGroupMessages, 10, 2, 10)
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
      turnCount: 0,
      messageCount: 0,
      maxTurns: this.maxTurns,
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
    return { ...room, participants: [...room.participants], messages: [] }
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
    return { ...next, participants: [...next.participants], messages: [...next.messages] }
  }

  public async reserveNext(roomId: string): Promise<{ readonly room: GroupRoomRecord; readonly botId: string } | undefined> {
    const current = await this.get(roomId)
    if (!current || current.closed || current.turnCount >= current.maxTurns || current.messageCount >= current.maxMessages) return undefined
    const botId = current.participants[current.nextParticipantIndex % current.participants.length]
    if (!botId) return undefined
    const next: GroupRoomRecord = {
      ...current,
      nextParticipantIndex: current.nextParticipantIndex + 1,
      turnCount: current.turnCount + 1,
      updatedAt: now(),
    }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return { room: { ...next, participants: [...next.participants], messages: [...next.messages] }, botId }
  }

  public async close(roomId: string): Promise<GroupRoomRecord | undefined> {
    const current = await this.get(roomId)
    if (!current) return undefined
    const next: GroupRoomRecord = { ...current, closed: true, updatedAt: now() }
    await this.state.update(state => {
      state.rooms[roomId] = next
      return state
    })
    return { ...next, participants: [...next.participants], messages: [...next.messages] }
  }

  public async get(roomId: string): Promise<GroupRoomRecord | undefined> {
    const current = (await this.state.load()).rooms[roomId]
    return current && { ...current, participants: [...current.participants], messages: [...current.messages] }
  }

  public async transcript(roomId: string): Promise<readonly GroupRoomMessage[]> {
    return (await this.get(roomId))?.messages ?? []
  }

  public async snapshot(): Promise<readonly GroupRoomRecord[]> {
    const rooms = (await this.state.load()).rooms
    return Object.values(rooms).map(room => ({ ...room, participants: [...room.participants], messages: [...room.messages] }))
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
  readonly roomId?: string
  readonly epoch?: number
  readonly payload: Record<string, unknown>
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
    ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    payload: { ...input.payload },
    createdAt: now(),
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
