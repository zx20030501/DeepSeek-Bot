import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import { assertNoCredentialMaterial } from './credential-scan.js'
import type { BotTarget } from './types.js'

export const ROUTINE_SCHEMA_VERSION = 1 as const
const MAX_CRON_SEARCH_MINUTES = 366 * 24 * 60 * 5

export class CronExpressionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'CronExpressionError'
  }
}

interface ParsedField {
  readonly values: ReadonlySet<number>
  readonly wildcard: boolean
}

export interface ParsedCronExpression {
  readonly expression: string
  readonly minute: ParsedField
  readonly hour: ParsedField
  readonly dayOfMonth: ParsedField
  readonly month: ParsedField
  readonly dayOfWeek: ParsedField
}

function parseInteger(raw: string, label: string): number {
  if (!/^\d+$/u.test(raw)) throw new CronExpressionError('Invalid ' + label + ' value: ' + raw)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new CronExpressionError('Invalid ' + label + ' value: ' + raw)
  return value
}

function parseField(
  raw: string,
  label: string,
  minimum: number,
  maximum: number,
  normalize: (value: number) => number = value => value,
): ParsedField {
  if (raw.trim().length === 0) throw new CronExpressionError('Empty cron ' + label + ' field')
  const values = new Set<number>()
  const tokens = raw.split(',')
  let wildcard = false
  for (const token of tokens) {
    const trimmed = token.trim()
    if (trimmed.length === 0) throw new CronExpressionError('Empty cron ' + label + ' item')
    const slash = trimmed.split('/')
    if (slash.length > 2) throw new CronExpressionError('Invalid cron step in ' + label + ': ' + trimmed)
    const base = slash[0]
    const step = slash.length === 2 ? parseInteger(slash[1], label + ' step') : 1
    if (step <= 0) throw new CronExpressionError('Cron step must be positive in ' + label)
    if (base === '*') wildcard = true
    let start: number
    let end: number
    if (base === '*') {
      start = minimum
      end = maximum
    } else if (base.includes('-')) {
      const range = base.split('-')
      if (range.length !== 2) throw new CronExpressionError('Invalid cron range in ' + label + ': ' + base)
      start = parseInteger(range[0], label)
      end = parseInteger(range[1], label)
      if (start > end) throw new CronExpressionError('Cron range is reversed in ' + label + ': ' + base)
    } else {
      if (slash.length === 2) throw new CronExpressionError('A stepped cron item needs * or a range in ' + label)
      start = parseInteger(base, label)
      end = start
    }
    if (start < minimum || end > maximum) {
      throw new CronExpressionError(
        'Cron ' + label + ' value must be between ' + minimum + ' and ' + maximum,
      )
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  if (values.size === 0) throw new CronExpressionError('Cron ' + label + ' field has no values')
  return { values, wildcard }
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== 'string') throw new CronExpressionError('Cron expression must be a string')
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) throw new CronExpressionError('Cron expression must contain exactly five fields')
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return {
    expression: fields.join(' '),
    minute: parseField(minute, 'minute', 0, 59),
    hour: parseField(hour, 'hour', 0, 23),
    dayOfMonth: parseField(dayOfMonth, 'day-of-month', 1, 31),
    month: parseField(month, 'month', 1, 12),
    dayOfWeek: parseField(dayOfWeek, 'day-of-week', 0, 7, value => value === 7 ? 0 : value),
  }
}

interface CalendarParts {
  readonly minute: number
  readonly hour: number
  readonly dayOfMonth: number
  readonly month: number
  readonly dayOfWeek: number
}

const weekdayNumbers: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function calendarParts(date: Date, timezone: string): CalendarParts {
  if (timezone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    }
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    })
  } catch (error: unknown) {
    throw new CronExpressionError('Invalid IANA timezone: ' + timezone + ' (' + String(error) + ')')
  }
  const values: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) values[part.type] = part.value
  const weekday = weekdayNumbers[values.weekday]
  if (weekday === undefined) throw new CronExpressionError('Could not resolve weekday for timezone: ' + timezone)
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekday,
  }
}

export function cronMatches(
  expression: string | ParsedCronExpression,
  at: Date | number,
  timezone = 'UTC',
): boolean {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) throw new CronExpressionError('Invalid date for cron matching')
  const parts = calendarParts(date, timezone)
  if (!parsed.minute.values.has(parts.minute) || !parsed.hour.values.has(parts.hour)) return false
  if (!parsed.month.values.has(parts.month)) return false
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(parts.dayOfMonth)
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(parts.dayOfWeek)
  // Cron's standard rule: when both day fields are restricted, either one may
  // match. A wildcard in either field turns that side into an unconstrained
  // value, so the combined result is an AND.
  if (!parsed.dayOfMonth.wildcard && !parsed.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches
  }
  return dayOfMonthMatches && dayOfWeekMatches
}

export function nextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterMs: number,
  timezone = 'UTC',
): number {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression
  if (!Number.isFinite(afterMs)) throw new CronExpressionError('Cron search start must be finite')
  // Occurrences are strictly after the supplied point. This keeps a
  // scheduler restart from running the same minute twice.
  let cursor = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  for (let index = 0; index < MAX_CRON_SEARCH_MINUTES; index += 1) {
    if (cronMatches(parsed, cursor, timezone)) return cursor
    cursor += 60_000
  }
  throw new CronExpressionError('No cron occurrence found within the five-year search horizon')
}

export type RoutineStatus = 'enabled' | 'disabled' | 'deleted'
export type RoutineLastRunStatus = 'started' | 'retrying' | 'failed'

export interface RoutineLaunch {
  readonly id: string
  readonly routineId: string
  readonly ownerId: string
  readonly workflowId: string
  readonly scheduledAt: number
  readonly attempt: number
  readonly inputs: Readonly<Record<string, unknown>>
  readonly replyTarget?: BotTarget
}

interface PendingRoutineLaunch {
  readonly id: string
  readonly scheduledAt: number
  readonly attempts: number
  readonly nextAttemptAt: number
  /** A short durable lease prevents duplicate dispatch while a launch is in flight. */
  readonly leaseUntil?: number
}

export interface RoutineRecord {
  readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
  readonly id: string
  readonly name: string
  readonly ownerId: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly replyTarget?: BotTarget
  readonly status: RoutineStatus
  readonly nextRunAt: number
  readonly pendingLaunch?: PendingRoutineLaunch
  readonly lastScheduledAt?: number
  readonly lastRunId?: string
  readonly lastRunStatus?: RoutineLastRunStatus
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateRoutineInput {
  readonly name: string
  readonly ownerId: string
  readonly workflowId: string
  readonly cron: string
  readonly timezone?: string
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly replyTarget?: BotTarget
  readonly enabled?: boolean
  readonly startAt?: number
}

export interface UpdateRoutineInput {
  readonly name?: string
  readonly workflowId?: string
  readonly cron?: string
  readonly timezone?: string
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly replyTarget?: BotTarget | null
  readonly enabled?: boolean
}

export type RoutineLaunchResult =
  | { readonly status: 'started'; readonly runId?: string }
  | { readonly status: 'failed'; readonly error: string; readonly retryable?: boolean }

export class RoutineStoreError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'RoutineStoreError'
  }
}

type RoutineEvent =
  | {
    readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
    readonly eventId: string
    readonly kind: 'snapshot'
    readonly at: number
    readonly routine: RoutineRecord
  }
  | {
    readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
    readonly eventId: string
    readonly kind: 'deleted'
    readonly at: number
    readonly routineId: string
  }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function assertRoutineInput(input: Readonly<Record<string, unknown>>): void {
  try {
    assertNoCredentialMaterial(input, 'Routine inputs must not contain credential material')
  } catch (error: unknown) {
    throw new RoutineStoreError('ROUTINE_CREDENTIALS', String(error))
  }
}

function validateRoutineText(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 256) {
    throw new RoutineStoreError('ROUTINE_INVALID_' + label.toUpperCase(), label + ' is empty or too long')
  }
  return normalized
}

function validRoutineEvent(value: unknown): value is RoutineEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<RoutineEvent>
  if (event.schemaVersion !== ROUTINE_SCHEMA_VERSION || typeof event.eventId !== 'string' || typeof event.at !== 'number') return false
  if (event.kind === 'deleted') return typeof event.routineId === 'string'
  if (event.kind !== 'snapshot' || event.routine === undefined) return false
  return event.routine.schemaVersion === ROUTINE_SCHEMA_VERSION
    && typeof event.routine.id === 'string'
    && typeof event.routine.name === 'string'
    && typeof event.routine.ownerId === 'string'
    && typeof event.routine.workflowId === 'string'
    && typeof event.routine.cron === 'string'
    && typeof event.routine.timezone === 'string'
    && typeof event.routine.nextRunAt === 'number'
}

function toLaunch(record: RoutineRecord): RoutineLaunch | undefined {
  const pending = record.pendingLaunch
  if (pending === undefined) return undefined
  return {
    id: pending.id,
    routineId: record.id,
    ownerId: record.ownerId,
    workflowId: record.workflowId,
    scheduledAt: pending.scheduledAt,
    attempt: pending.attempts,
    inputs: clone(record.inputs),
    ...(record.replyTarget === undefined ? {} : { replyTarget: clone(record.replyTarget) }),
  }
}

export class RoutineStore {
  private readonly journal: JsonlJournal<RoutineEvent>
  private readonly routines = new Map<string, RoutineRecord>()
  private loaded = false
  private mutationTail: Promise<void> = Promise.resolve()

  public constructor(
    private readonly file: string,
    private readonly maxLaunchAttempts = 3,
    private readonly retryBaseMs = 1_000,
    private readonly retryMaxMs = 60_000,
    private readonly launchLeaseMs = 60_000,
  ) {
    if (!Number.isSafeInteger(maxLaunchAttempts) || maxLaunchAttempts < 1) {
      throw new RoutineStoreError('ROUTINE_INVALID_ATTEMPTS', 'maxLaunchAttempts must be a positive integer')
    }
    this.journal = new JsonlJournal<RoutineEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (!validRoutineEvent(event)) {
        throw new RoutineStoreError('ROUTINE_STORE_CORRUPT', 'Routine store contains an invalid event')
      }
      if (event.kind === 'deleted') this.routines.delete(event.routineId)
      else this.routines.set(event.routine.id, clone(event.routine))
    }
    this.loaded = true
  }

  public async create(input: CreateRoutineInput, at = Date.now()): Promise<RoutineRecord> {
    return this.mutate(async () => {
      await this.load()
      const name = validateRoutineText(input.name, 'name')
      const ownerId = validateRoutineText(input.ownerId, 'ownerId')
      const workflowId = validateRoutineText(input.workflowId, 'workflowId')
      const cron = parseCronExpression(input.cron).expression
      const timezone = validateRoutineText(input.timezone ?? 'UTC', 'timezone')
      // Validate the timezone before writing a durable record.
      calendarParts(new Date(at), timezone)
      const inputs = input.inputs ?? {}
      assertRoutineInput(inputs)
      if (!Number.isFinite(at)) throw new RoutineStoreError('ROUTINE_INVALID_TIME', 'Routine timestamp must be finite')
      const enabled = input.enabled !== false
      const nextRunAt = nextCronOccurrence(cron, input.startAt ?? at, timezone)
      const record: RoutineRecord = {
        schemaVersion: ROUTINE_SCHEMA_VERSION,
        id: 'routine_' + randomUUID(),
        name,
        ownerId,
        workflowId,
        cron,
        timezone,
        inputs: clone(inputs),
        ...(input.replyTarget === undefined ? {} : { replyTarget: clone(input.replyTarget) }),
        status: enabled ? 'enabled' : 'disabled',
        nextRunAt,
        createdAt: at,
        updatedAt: at,
      }
      await this.append({ kind: 'snapshot', routine: record, at })
      return clone(record)
    })
  }

  public async get(id: string): Promise<RoutineRecord | undefined> {
    await this.load()
    const record = this.routines.get(id)
    return record === undefined ? undefined : clone(record)
  }

  public async list(includeDeleted = false): Promise<RoutineRecord[]> {
    await this.load()
    return [...this.routines.values()]
      .filter(record => includeDeleted || record.status !== 'deleted')
      .sort((left, right) => left.nextRunAt - right.nextRunAt || left.id.localeCompare(right.id))
      .map(record => clone(record))
  }

  public async update(id: string, patch: UpdateRoutineInput, at = Date.now()): Promise<RoutineRecord> {
    return this.mutate(async () => {
      await this.load()
      const current = this.routines.get(id)
      if (current === undefined) throw new RoutineStoreError('ROUTINE_NOT_FOUND', 'Routine does not exist: ' + id)
      if (current.status === 'deleted') throw new RoutineStoreError('ROUTINE_DELETED', 'Routine is deleted: ' + id)
      const name = patch.name === undefined ? current.name : validateRoutineText(patch.name, 'name')
      const workflowId = patch.workflowId === undefined ? current.workflowId : validateRoutineText(patch.workflowId, 'workflowId')
      const cron = patch.cron === undefined ? current.cron : parseCronExpression(patch.cron).expression
      const timezone = patch.timezone === undefined ? current.timezone : validateRoutineText(patch.timezone, 'timezone')
      calendarParts(new Date(at), timezone)
      const inputs = patch.inputs === undefined ? current.inputs : patch.inputs
      assertRoutineInput(inputs)
      const cronChanged = cron !== current.cron || timezone !== current.timezone
      const enabled = patch.enabled ?? current.status === 'enabled'
      const nextRunAt = cronChanged
        ? nextCronOccurrence(cron, at - 60_000, timezone)
        : current.nextRunAt
      const { replyTarget: previousReplyTarget, ...withoutReplyTarget } = current
      const base: Omit<RoutineRecord, 'replyTarget'> = {
        ...withoutReplyTarget,
        name,
        workflowId,
        cron,
        timezone,
        inputs: clone(inputs),
        status: enabled ? 'enabled' : 'disabled',
        nextRunAt,
        updatedAt: at,
      }
      const updated: RoutineRecord = 'replyTarget' in patch
        ? (patch.replyTarget === null
          ? base
          : { ...base, replyTarget: clone(patch.replyTarget) })
        : { ...base, ...(previousReplyTarget === undefined ? {} : { replyTarget: clone(previousReplyTarget) }) }
      await this.append({ kind: 'snapshot', routine: updated, at })
      return clone(updated)
    })
  }

  public async delete(id: string, at = Date.now()): Promise<void> {
    await this.mutate(async () => {
      await this.load()
      const current = this.routines.get(id)
      if (current === undefined) return
      this.routines.delete(id)
      await this.journal.append({
        schemaVersion: ROUTINE_SCHEMA_VERSION,
        eventId: randomUUID(),
        kind: 'deleted',
        at,
        routineId: id,
      })
    })
  }

  /**
   * Reserve due launches before calling the Workflow runtime. The reservation
   * is durable, so a crash after this method returns is recovered as the same
   * launch ID instead of silently losing a scheduled run.
   */
  public async claimDue(now = Date.now(), limit = 32): Promise<RoutineLaunch[]> {
    return this.mutate(async () => {
      await this.load()
      const candidates = [...this.routines.values()]
        .filter(record => record.status === 'enabled')
        .filter(record => (
          record.pendingLaunch !== undefined
            ? record.pendingLaunch.nextAttemptAt <= now
              && (record.pendingLaunch.leaseUntil === undefined || record.pendingLaunch.leaseUntil <= now)
            : record.nextRunAt <= now
        ))
        .sort((left, right) => left.nextRunAt - right.nextRunAt || left.id.localeCompare(right.id))
      const launches: RoutineLaunch[] = []
      for (const current of candidates.slice(0, Math.max(0, limit))) {
        const pending = current.pendingLaunch ?? {
          id: 'routine-run:' + current.id + ':' + current.nextRunAt,
          scheduledAt: current.nextRunAt,
          attempts: 1,
          nextAttemptAt: now,
          leaseUntil: now + this.launchLeaseMs,
        }
        const renewedPending: PendingRoutineLaunch = {
          ...pending,
          leaseUntil: now + this.launchLeaseMs,
        }
        const updated: RoutineRecord = {
          ...current,
          pendingLaunch: renewedPending,
          updatedAt: now,
        }
        if (current.pendingLaunch === undefined || current.pendingLaunch.leaseUntil !== renewedPending.leaseUntil) {
          await this.append({ kind: 'snapshot', routine: updated, at: now })
        }
        this.routines.set(current.id, clone(updated))
        const launch = toLaunch(updated)
        if (launch !== undefined) launches.push(launch)
      }
      return launches
    })
  }

  public async recordLaunchResult(
    routineId: string,
    launchId: string,
    result: RoutineLaunchResult,
    at = Date.now(),
  ): Promise<RoutineRecord | undefined> {
    return this.mutate(async () => {
      await this.load()
      const current = this.routines.get(routineId)
      if (current === undefined || current.pendingLaunch?.id !== launchId) return current === undefined ? undefined : clone(current)
      const pending = current.pendingLaunch
      if (result.status === 'failed' && result.retryable === true && pending.attempts < this.maxLaunchAttempts) {
        const { leaseUntil: _leaseUntil, ...withoutLease } = pending
        const retryPending: PendingRoutineLaunch = {
          ...withoutLease,
          attempts: pending.attempts + 1,
          nextAttemptAt: at + this.backoff(pending.attempts),
        }
        const retrying: RoutineRecord = {
          ...current,
          pendingLaunch: retryPending,
          lastRunStatus: 'retrying',
          lastError: result.error,
          updatedAt: at,
        }
        await this.append({ kind: 'snapshot', routine: retrying, at })
        return clone(retrying)
      }
      const nextRunAt = nextCronOccurrence(current.cron, pending.scheduledAt, current.timezone)
      const { pendingLaunch: _pending, ...withoutPending } = current
      const completed: RoutineRecord = {
        ...withoutPending,
        nextRunAt,
        lastScheduledAt: pending.scheduledAt,
        ...(result.status === 'started' ? {
          lastRunStatus: 'started' as const,
          ...(result.runId === undefined ? {} : { lastRunId: result.runId }),
        } : {
          lastRunStatus: 'failed' as const,
          lastError: result.error,
        }),
        updatedAt: at,
      }
      await this.append({ kind: 'snapshot', routine: completed, at })
      return clone(completed)
    })
  }

  private async append(input: { kind: 'snapshot'; routine: RoutineRecord; at: number }): Promise<void> {
    this.routines.set(input.routine.id, clone(input.routine))
    await this.journal.append({
      schemaVersion: ROUTINE_SCHEMA_VERSION,
      eventId: randomUUID(),
      kind: input.kind,
      at: input.at,
      routine: input.routine,
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempt - 1))
  }
}

export type RoutineLaunchHandler = (launch: RoutineLaunch) => Promise<RoutineLaunchResult>

export interface RoutineSchedulerOptions {
  readonly store: RoutineStore
  readonly launch: RoutineLaunchHandler
  readonly pollMs?: number
  readonly maxDuePerTick?: number
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export class RoutineScheduler {
  private readonly pollMs: number
  private readonly maxDuePerTick: number
  private readonly now: () => number
  private readonly onError?: (error: unknown) => void
  private readonly active = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  public constructor(private readonly options: RoutineSchedulerOptions) {
    this.pollMs = Math.max(250, options.pollMs ?? 15_000)
    this.maxDuePerTick = Math.max(1, options.maxDuePerTick ?? 32)
    this.now = options.now ?? (() => Date.now())
    this.onError = options.onError
  }

  public start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  public async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await Promise.allSettled([...this.active])
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    try {
      const launches = await this.options.store.claimDue(this.now(), this.maxDuePerTick)
      for (const launch of launches) {
        const task = this.dispatch(launch)
        this.active.add(task)
        void task.finally(() => this.active.delete(task))
      }
    } catch (error: unknown) {
      this.onError?.(error)
    } finally {
      if (this.running) this.timer = setTimeout(() => { void this.tick() }, this.pollMs)
    }
  }

  private async dispatch(launch: RoutineLaunch): Promise<void> {
    try {
      const result = await this.options.launch(launch)
      await this.options.store.recordLaunchResult(launch.routineId, launch.id, result, this.now())
    } catch (error: unknown) {
      this.onError?.(error)
      try {
        await this.options.store.recordLaunchResult(
          launch.routineId,
          launch.id,
          { status: 'failed', error: String(error), retryable: true },
          this.now(),
        )
      } catch (recordError: unknown) {
        this.onError?.(recordError)
      }
    }
  }
}
