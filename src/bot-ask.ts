import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import type { BotAddress, BotMessageEnvelope, BotTarget } from './types.js'

/**
 * bot_ask / bot_wait
 *
 * A durable request-reply seam between Bots. An Ask is registered durably
 * before any message is sent, so a restart cannot lose an outstanding
 * question. Replies carry the `askId` in their payload and are correlated by
 * the Ask's `correlationId`/`traceId` regardless of which Team, Thread or
 * Room they flow through; `parentAskId` links chained asks.
 */

export type BotAskStatus = 'pending' | 'answered' | 'timed-out' | 'cancelled'

export interface BotAskReply {
  readonly from: string
  readonly text: string
  readonly at: number
  readonly messageId: string
}

export interface BotAskRecord {
  readonly askId: string
  readonly correlationId: string
  readonly traceId: string
  readonly conversationId?: string
  readonly from: string
  readonly to: readonly string[]
  readonly question: string
  readonly status: BotAskStatus
  readonly replies: readonly BotAskReply[]
  readonly deadline: number
  readonly maxReplies?: number
  readonly teamId?: string
  readonly threadId?: string
  readonly roomId?: string
  readonly parentAskId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly error?: string
}

export interface BotAskRegisterInput {
  readonly from: string
  readonly to: readonly string[]
  readonly question: string
  readonly ttlMs?: number
  readonly maxReplies?: number
  readonly conversationId?: string
  readonly traceId?: string
  readonly correlationId?: string
  readonly teamId?: string
  readonly threadId?: string
  readonly roomId?: string
  readonly parentAskId?: string
}

export interface BotAskReplyInput {
  readonly from: string
  readonly text: string
  readonly messageId: string
  readonly at?: number
}

export interface BotAskWaitOptions {
  /** How long this caller waits before returning the current state. Default 30s. */
  readonly timeoutMs?: number
  readonly pollMs?: number
}

export interface BotAskInput {
  readonly from: string
  readonly to: readonly string[]
  readonly question: string
  readonly replyTarget: BotTarget
  readonly ttlMs?: number
  readonly maxReplies?: number
  readonly conversationId?: string
  readonly traceId?: string
  readonly correlationId?: string
  readonly teamId?: string
  readonly threadId?: string
  readonly roomId?: string
  readonly parentAskId?: string
  readonly payload?: Readonly<Record<string, unknown>>
  readonly fromAddress?: BotAddress
}

export interface BotAskResult {
  readonly askId: string
  readonly correlationId: string
  readonly status: BotAskStatus
  readonly question: string
  readonly from: string
  readonly to: readonly string[]
  readonly replies: readonly BotAskReply[]
  /** Envelopes enqueued for each target when the Ask was created. */
  readonly envelopes?: readonly BotMessageEnvelope[]
  /** True when the caller's wait budget elapsed while the Ask was still pending. */
  readonly timedOut: boolean
}

const DEFAULT_TTL_MS = 30 * 60_000
const MIN_TTL_MS = 5_000
const MAX_TTL_MS = 24 * 60 * 60_000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 100
const MIN_POLL_MS = 20
const MAX_POLL_MS = 1_000
const MAX_ASK_TARGETS = 6
const MAX_QUESTION_LENGTH = 4_000
const MAX_REPLY_LENGTH = 50_000

interface BotAskEvent {
  readonly kind: 'registered' | 'state'
  readonly record: BotAskRecord
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value !== undefined && Number.isFinite(value) ? value : fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(selected)))
}

function identity(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim()
  if (normalized === '') throw new Error(field + ' must not be empty')
  return normalized
}

/**
 * Durable, append-only Ask ledger. Each transition persists the full record,
 * so replay is order-independent and a restart simply continues where the
 * journal stopped.
 */
export class BotAskRegistry {
  private readonly journal: JsonlJournal<BotAskEvent>
  private readonly items = new Map<string, BotAskRecord>()
  private loaded = false
  private maxTargets = MAX_ASK_TARGETS

  public constructor(file: string) {
    this.journal = new JsonlJournal<BotAskEvent>(file)
  }

  public configure(maxTargets = MAX_ASK_TARGETS): void {
    this.maxTargets = Math.max(1, Math.min(MAX_ASK_TARGETS, Math.floor(maxTargets)))
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (event.record !== undefined && event.record !== null) this.items.set(event.record.askId, event.record)
    }
    this.loaded = true
  }

  public async register(input: BotAskRegisterInput): Promise<BotAskRecord> {
    await this.load()
    const timestamp = Date.now()
    const askId = 'ask_' + randomUUID()
    const from = identity(input.from, 'ask.from')
    const question = String(input.question ?? '').trim()
    if (question === '') throw new Error('ask.question must not be empty')
    const to = [...new Set(input.to.map(id => identity(id, 'ask.to').toLowerCase()))].slice(0, this.maxTargets)
    if (to.length === 0) throw new Error('ask requires at least one target Bot')
    const ttlMs = bounded(input.ttlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)
    const correlationId = identity(input.correlationId ?? askId, 'ask.correlationId')
    const traceId = identity(input.traceId ?? correlationId, 'ask.traceId')
    const record: BotAskRecord = {
      askId,
      correlationId,
      traceId,
      ...(input.conversationId === undefined ? {} : { conversationId: identity(input.conversationId, 'ask.conversationId') }),
      from,
      to,
      question: question.slice(0, MAX_QUESTION_LENGTH),
      status: 'pending',
      replies: [],
      deadline: timestamp + ttlMs,
      ...(input.maxReplies === undefined ? {} : { maxReplies: Math.max(1, Math.floor(input.maxReplies)) }),
      ...(input.teamId === undefined ? {} : { teamId: identity(input.teamId, 'ask.teamId') }),
      ...(input.threadId === undefined ? {} : { threadId: identity(input.threadId, 'ask.threadId') }),
      ...(input.roomId === undefined ? {} : { roomId: identity(input.roomId, 'ask.roomId') }),
      ...(input.parentAskId === undefined ? {} : { parentAskId: identity(input.parentAskId, 'ask.parentAskId') }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.record(record)
    return this.clone(record)
  }

  /**
   * Record one reply. One reply per target Bot is kept: a later reply from the
   * same target replaces the earlier one, which makes a retried reply
   * idempotent without losing the aggregate. The Ask transitions to
   * `answered` once every target has replied or `maxReplies` is reached.
   */
  public async recordReply(askId: string, input: BotAskReplyInput): Promise<BotAskRecord | undefined> {
    await this.load()
    const current = this.items.get(askId)
    if (!current) return undefined
    const at = input.at ?? Date.now()
    const from = identity(input.from, 'ask.reply.from')
    const text = String(input.text ?? '').trim().slice(0, MAX_REPLY_LENGTH)
    const messageId = identity(input.messageId, 'ask.reply.messageId')
    if (current.replies.some(reply => reply.messageId === messageId)) return this.clone(current)
    const replies = [
      ...current.replies.filter(reply => reply.from !== from),
      { from, text: text === '' ? '(empty)' : text, at, messageId },
    ]
    let status = current.status
    if (current.status === 'pending') {
      const everyTargetReplied = current.to.every(target => replies.some(reply => reply.from === target))
      const budgetReached = current.maxReplies !== undefined && replies.length >= current.maxReplies
      if (everyTargetReplied || budgetReached) status = 'answered'
    }
    const next: BotAskRecord = { ...current, replies, status, updatedAt: at }
    await this.record(next)
    return this.clone(next)
  }

  /** Advance every pending Ask whose deadline passed to `timed-out`. */
  public async expire(at = Date.now()): Promise<BotAskRecord[]> {
    await this.load()
    const changed: BotAskRecord[] = []
    for (const current of [...this.items.values()]) {
      if (current.status !== 'pending' || current.deadline > at) continue
      const next: BotAskRecord = { ...current, status: 'timed-out', updatedAt: at, error: 'ask deadline passed' }
      await this.record(next)
      changed.push(this.clone(next))
    }
    return changed
  }

  public async cancel(askId: string, reason: string, actor = 'system'): Promise<BotAskRecord | undefined> {
    await this.load()
    const current = this.items.get(askId)
    if (!current || current.status !== 'pending') return undefined
    const next: BotAskRecord = {
      ...current,
      status: 'cancelled',
      updatedAt: Date.now(),
      error: (actor === 'system' ? 'cancelled: ' : actor + ': ') + String(reason).slice(0, 500),
    }
    await this.record(next)
    return this.clone(next)
  }

  public async get(askId: string): Promise<BotAskRecord | undefined> {
    await this.expire()
    const current = this.items.get(askId)
    return current && this.clone(current)
  }

  public async pending(): Promise<BotAskRecord[]> {
    await this.expire()
    return [...this.items.values()]
      .filter(record => record.status === 'pending')
      .map(record => this.clone(record))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  public async snapshot(): Promise<BotAskRecord[]> {
    await this.expire()
    return [...this.items.values()]
      .map(record => this.clone(record))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Wait until the Ask is no longer pending, its deadline passes, or the caller's budget elapses. */
  public async wait(askId: string, options: BotAskWaitOptions = {}): Promise<BotAskRecord> {
    const timeoutMs = bounded(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 0, MAX_TTL_MS)
    const pollMs = bounded(options.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS)
    await this.load()
    if (!this.items.has(askId)) throw new Error('bot ask not found: ' + askId)
    const started = Date.now()
    for (;;) {
      await this.expire()
      const current = this.items.get(askId)
      if (current && current.status !== 'pending') return this.clone(current)
      if (Date.now() - started >= timeoutMs) {
        if (current) return this.clone(current)
        throw new Error('bot ask disappeared: ' + askId)
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }

  private async record(record: BotAskRecord): Promise<void> {
    this.items.set(record.askId, record)
    await this.journal.append({ kind: 'state', record })
  }

  private clone(record: BotAskRecord): BotAskRecord {
    return { ...record, to: [...record.to], replies: record.replies.map(reply => ({ ...reply })) }
  }
}

/** Stable idempotency key for a reply to an Ask, so a retried reply cannot double-enqueue. */
export function askReplyIdempotencyKey(askId: string, from: string): string {
  return 'ask:reply:' + askId + ':' + String(from).toLowerCase()
}
