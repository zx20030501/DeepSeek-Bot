import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import type { ManagerBotDescriptor, ManagerBotStatus, ManagerPlan, ReplanSuggestion } from './fleet-v2-types.js'

/**
 * Manager control plane (Phase 3)
 *
 * Durable building blocks that let a Manager Bot observe, wait on, pause,
 * stop and replan Fleet work, with every action persisted to a replayable
 * journal so a restarted Manager can recover its full history.
 */

export type ManagerActionKind =
  | 'plan'
  | 'dispatch'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'replan'
  | 'wait'
  | 'observe'

export interface ManagerActionInput {
  readonly kind: ManagerActionKind
  readonly actor: string
  readonly taskId?: string
  readonly traceId?: string
  readonly botId?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface ManagerActionRecord extends ManagerActionInput {
  readonly actionId: string
  readonly at: number
}

export interface ManagerActionQuery {
  readonly kind?: ManagerActionKind
  readonly taskId?: string
  readonly botId?: string
  readonly since?: number
  readonly limit?: number
}

const MAX_ACTION_AGE = 24 * 60 * 60 * 1_000
const MAX_ACTIONS_IN_MEMORY = 2_000

/**
 * Append-only journal of every Manager action. `forTask` and `since` give a
 * restarted Manager the exact history it needs to recover mid-flight.
 */
export class ManagerActionLog {
  private readonly journal: JsonlJournal<ManagerActionRecord>
  private readonly items: ManagerActionRecord[] = []
  private loaded = false

  public constructor(file: string) {
    this.journal = new JsonlJournal<ManagerActionRecord>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const action of await this.journal.read()) {
      if (action !== undefined && action !== null && typeof action.actionId === 'string') {
        this.items.push(action)
      }
    }
    this.trim()
    this.loaded = true
  }

  public async record(input: ManagerActionInput): Promise<ManagerActionRecord> {
    await this.load()
    const action: ManagerActionRecord = {
      ...input,
      detail: input.detail === undefined ? {} : structuredClone(input.detail),
      actionId: 'mact_' + randomUUID(),
      at: Date.now(),
    }
    this.items.push(action)
    this.trim()
    await this.journal.append(action)
    return { ...action, detail: { ...action.detail } }
  }

  public async query(query: ManagerActionQuery = {}): Promise<ManagerActionRecord[]> {
    await this.load()
    const limit = query.limit === undefined ? 100 : Math.max(1, Math.min(500, Math.floor(query.limit)))
    return [...this.items]
      .filter(action => query.kind === undefined || action.kind === query.kind)
      .filter(action => query.taskId === undefined || action.taskId === query.taskId)
      .filter(action => query.botId === undefined || action.botId === query.botId)
      .filter(action => query.since === undefined || action.at >= query.since)
      .slice(-limit)
      .reverse()
      .map(action => ({ ...action, detail: { ...action.detail } }))
  }

  /** All actions for one task in journal order; the recovery view for a Manager. */
  public async forTask(taskId: string): Promise<ManagerActionRecord[]> {
    await this.load()
    return this.items
      .filter(action => action.taskId === taskId)
      .map(action => ({ ...action, detail: { ...action.detail } }))
  }

  /** The most recent action of a kind for a task, e.g. the last stored plan. */
  public async last(taskId: string, kind: ManagerActionKind): Promise<ManagerActionRecord | undefined> {
    await this.load()
    const matches = this.items.filter(action => action.taskId === taskId && action.kind === kind)
    const last = matches[matches.length - 1]
    return last && { ...last, detail: { ...last.detail } }
  }

  private trim(): void {
    const cutoff = Date.now() - MAX_ACTION_AGE
    while (this.items.length > MAX_ACTIONS_IN_MEMORY || (this.items.length > 0 && this.items[0]!.at < cutoff)) {
      this.items.shift()
    }
  }
}

export interface ManagerPauseInput {
  readonly botId: string
  readonly reason?: string
  /** 0 (default) means until explicitly resumed. */
  readonly durationMs?: number
  readonly actor: string
}

export interface ManagerPauseRecord {
  readonly botId: string
  readonly reason: string
  readonly actor: string
  readonly until: number
  readonly createdAt: number
}

const MAX_PAUSE_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * Durable pause registry. A paused Bot is excluded from Manager planning and
 * dispatch until resumed or the deadline passes.
 */
export class ManagerPauseRegistry {
  private readonly journal: JsonlJournal<ManagerPauseRecord>
  private readonly items = new Map<string, ManagerPauseRecord>()
  private loaded = false

  public constructor(file: string) {
    this.journal = new JsonlJournal<ManagerPauseRecord>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const record of await this.journal.read()) {
      if (record !== undefined && record !== null && typeof record.botId === 'string') {
        this.items.set(record.botId, record)
      }
    }
    this.loaded = true
  }

  public async pause(input: ManagerPauseInput): Promise<ManagerPauseRecord> {
    await this.load()
    const botId = String(input.botId).trim().toLowerCase()
    if (botId === '') throw new Error('pause requires a Bot id')
    const durationMs = input.durationMs === undefined
      ? 0
      : Math.max(1_000, Math.min(MAX_PAUSE_MS, Math.floor(input.durationMs)))
    const record: ManagerPauseRecord = {
      botId,
      reason: String(input.reason ?? 'paused by Manager').slice(0, 500),
      actor: String(input.actor ?? 'manager').slice(0, 128),
      until: durationMs === 0 ? 0 : Date.now() + durationMs,
      createdAt: Date.now(),
    }
    this.items.set(botId, record)
    await this.journal.append(record)
    return { ...record }
  }

  public async resume(botId: string, actor = 'manager'): Promise<ManagerPauseRecord | undefined> {
    await this.load()
    const normalized = String(botId).trim().toLowerCase()
    const current = this.items.get(normalized)
    if (!current) return undefined
    await this.journal.append({ ...current, until: 0, reason: current.reason + ` (resumed by ${actor})`, actor })
    const resumed: ManagerPauseRecord = { ...current, until: 0, actor }
    this.items.delete(normalized)
    return { ...resumed }
  }

  public async paused(at = Date.now()): Promise<ManagerPauseRecord[]> {
    await this.load()
    await this.sweep(at)
    return [...this.items.values()].map(record => ({ ...record }))
  }

  public async isPaused(botId: string, at = Date.now()): Promise<boolean> {
    await this.load()
    await this.sweep(at)
    const record = this.items.get(String(botId).trim().toLowerCase())
    return record !== undefined && (record.until === 0 || record.until > at)
  }

  public async sweep(at = Date.now()): Promise<void> {
    await this.load()
    for (const [botId, record] of [...this.items.entries()]) {
      if (record.until > 0 && record.until <= at) this.items.delete(botId)
    }
  }
}

export interface ManagerObserveOptions {
  readonly maxBots?: number
  readonly maxTasks?: number
  readonly record?: boolean
}

export interface ManagerBotObservation {
  readonly id: string
  readonly title?: string
  readonly status: ManagerBotStatus
  readonly inFlight: number
  readonly capabilities: readonly string[]
  readonly skills: readonly string[]
  readonly role?: string
  readonly paused?: { readonly reason: string; readonly until: number }
  readonly lastFailure?: { readonly runId: string; readonly error: string; readonly at: number }
}

export interface ManagerObservation {
  readonly now: number
  readonly bots: readonly ManagerBotObservation[]
  readonly tasks: readonly Record<string, unknown>[]
  readonly runs: readonly Record<string, unknown>[]
  readonly asks: { readonly pending: number; readonly answered: number; readonly 'timed-out': number; readonly cancelled: number }
  readonly workflows: { readonly active: number; readonly completed: number; readonly failed: number; readonly cancelled: number }
  readonly pauses: readonly ManagerPauseRecord[]
}

export interface ManagerWaitOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
}

export interface ManagerWaitResult {
  readonly taskId: string
  readonly status: string
  readonly result?: string
  readonly error?: string
  readonly timedOut: boolean
  readonly waitedMs: number
}

export interface ManagerPauseActionResult {
  readonly botId: string
  readonly reason: string
  readonly until: number
}

export interface ManagerStopResult {
  readonly taskId: string
  readonly cancelled: boolean
  readonly status?: string
}

export interface ManagerReplanObservationInput {
  readonly botId: string
  readonly status: Exclude<ManagerBotStatus, 'available' | 'busy'>
  readonly reason?: string
  readonly confidence?: number
}

export interface ManagerReplanInput {
  readonly taskId: string
  readonly observations: readonly ManagerReplanObservationInput[]
  readonly actor?: string
  readonly auto?: boolean
}

export interface ManagerReplanResult {
  readonly taskId: string
  readonly traceId: string
  readonly suggestion: ReplanSuggestion
  readonly autoDispatched: boolean
  readonly dispatchedTaskId?: string
  readonly dispatchedEnvelopes?: readonly unknown[]
  readonly approvalCode?: string
  readonly plan?: ManagerPlan
}

export function normalizeManagerReplanObservations(
  observations: readonly ManagerReplanObservationInput[],
): readonly import('./fleet-v2-types.js').ManagerReplanObservation[] {
  return [...new Map(observations.map(observation => {
    const botId = String(observation.botId).trim().toLowerCase()
    if (botId === '') throw new Error('replan observation requires a Bot id')
    const status = observation.status
    if (status !== 'unavailable' && status !== 'timeout' && status !== 'failed' && status !== 'low-confidence') {
      throw new Error('replan observation status must be a failure-like status: ' + botId)
    }
    return [botId, {
      botId,
      status,
      ...(observation.reason === undefined ? {} : { reason: String(observation.reason).slice(0, 500) }),
      ...(observation.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, observation.confidence)) }),
    }] as const
  })).values()]
}

/** Bound a wait budget: at least 0, at most 24h. */
export function boundedWaitTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs === undefined || !Number.isFinite(timeoutMs) ? 30_000 : Math.floor(timeoutMs)
  return Math.max(0, Math.min(24 * 60 * 60 * 1_000, value))
}

export function boundedPollInterval(pollMs: number | undefined): number {
  const value = pollMs === undefined || !Number.isFinite(pollMs) ? 100 : Math.floor(pollMs)
  return Math.max(20, Math.min(1_000, value))
}

export type { ManagerBotDescriptor, ManagerPlan, ReplanSuggestion }
