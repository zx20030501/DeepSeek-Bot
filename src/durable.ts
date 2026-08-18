import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import type { InboundMessage, OutboxItem, OutboxState, WalItem, WalState } from './types.js'

interface WalEvent {
  readonly kind: 'accepted' | 'state'
  readonly id: string
  readonly message?: InboundMessage
  readonly sessionId?: string
  readonly state?: WalState
  readonly attempts?: number
  readonly lastError?: string
  readonly updatedAt: number
}

export interface WalAcceptResult {
  readonly item: WalItem
  readonly inserted: boolean
}

function laneKey(target: { platform: string; chatId: string; threadId?: string }): string {
  return [target.platform, target.chatId, target.threadId ?? ''].join(':')
}

/**
 * Inbound write-ahead log. The accepted record is written before the Agent is
 * touched; a later state record is the recovery point after a restart.
 */
export class InboundWal {
  private readonly journal: JsonlJournal<WalEvent>
  private readonly items = new Map<string, WalItem>()
  private acceptTail: Promise<void> = Promise.resolve()
  private loaded = false

  public constructor(private readonly file: string, private readonly maxAttempts = 3) {
    this.journal = new JsonlJournal<WalEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (event.kind === 'accepted' && event.message) {
        this.items.set(event.id, {
          id: event.id,
          state: 'accepted',
          message: event.message,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          attempts: event.attempts ?? 0,
          updatedAt: event.updatedAt,
        })
      } else if (event.kind === 'state') {
        const previous = this.items.get(event.id)
        if (!previous || event.state === undefined) continue
        this.items.set(event.id, {
          ...previous,
          state: event.state,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          attempts: event.attempts ?? previous.attempts,
          ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
          updatedAt: event.updatedAt,
        })
      }
    }
    this.loaded = true
  }

  public async accept(message: InboundMessage): Promise<WalAcceptResult> {
    let result: WalAcceptResult | undefined
    const operation = this.acceptTail.then(async () => {
      await this.load()
      const existing = this.items.get(message.id)
      if (existing && existing.state !== 'failed') {
        result = { item: { ...existing }, inserted: false }
        return
      }
      const item: WalItem = {
        id: message.id,
        state: 'accepted',
        message,
        attempts: 0,
        updatedAt: Date.now(),
      }
      this.items.set(item.id, item)
      await this.journal.append({
        kind: 'accepted',
        id: item.id,
        message,
        attempts: 0,
        updatedAt: item.updatedAt,
      })
      result = { item: { ...item }, inserted: true }
    })
    this.acceptTail = operation.then(() => undefined, () => undefined)
    await operation
    if (!result) throw new Error('inbound WAL accept did not produce a result')
    return result
  }

  public async get(id: string): Promise<WalItem | undefined> {
    await this.load()
    const item = this.items.get(id)
    return item && { ...item }
  }

  public async claim(id: string, sessionId: string): Promise<WalItem | undefined> {
    await this.load()
    const current = this.items.get(id)
    if (!current || current.state === 'completed' || current.state === 'failed') return undefined
    if (current.attempts >= this.maxAttempts) return undefined
    const item: WalItem = {
      ...current,
      state: 'dispatched',
      sessionId,
      attempts: current.attempts + 1,
      updatedAt: Date.now(),
    }
    this.items.set(id, item)
    await this.journal.append({
      kind: 'state',
      id,
      state: item.state,
      sessionId,
      attempts: item.attempts,
      updatedAt: item.updatedAt,
    })
    return { ...item }
  }

  public async complete(id: string): Promise<void> {
    await this.transition(id, 'completed')
  }

  public async fail(id: string, error: unknown, retry = true): Promise<WalItem | undefined> {
    await this.load()
    const current = this.items.get(id)
    if (!current || current.state === 'completed') return undefined
    const state: WalState = retry && current.attempts < this.maxAttempts ? 'accepted' : 'failed'
    return this.transition(id, state, String(error))
  }

  public async pending(): Promise<WalItem[]> {
    await this.load()
    return [...this.items.values()]
      .filter(item => (item.state === 'accepted' || item.state === 'dispatched') && item.attempts < this.maxAttempts)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map(item => ({ ...item }))
  }

  public async pendingForSession(sessionId: string): Promise<WalItem[]> {
    return (await this.pending()).filter(item => item.sessionId === sessionId)
  }

  public async snapshot(): Promise<WalItem[]> {
    await this.load()
    return [...this.items.values()].map(item => ({ ...item }))
  }

  private async transition(id: string, state: WalState, lastError?: string): Promise<WalItem | undefined> {
    await this.load()
    const current = this.items.get(id)
    if (!current || current.state === 'completed') return undefined
    const item: WalItem = {
      ...current,
      state,
      ...(lastError === undefined ? {} : { lastError }),
      updatedAt: Date.now(),
    }
    this.items.set(id, item)
    await this.journal.append({
      kind: 'state',
      id,
      state,
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
      attempts: item.attempts,
      ...(lastError === undefined ? {} : { lastError }),
      updatedAt: item.updatedAt,
    })
    return { ...item }
  }
}

interface OutboxJournalEvent extends OutboxItem {}

export type OutboxSender = (item: OutboxItem) => Promise<void>

/**
 * At-least-once delivery queue. A successful platform call is followed by a
 * durable `sent` snapshot; ambiguous network failures may produce a duplicate,
 * which is the honest trade-off for not losing a model response.
 */
export class Outbox {
  private readonly journal: JsonlJournal<OutboxJournalEvent>
  private readonly items = new Map<string, OutboxItem>()
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly waiters = new Set<() => void>()
  private loaded = false
  private active = true

  public constructor(
    file: string,
    private readonly sender: OutboxSender,
    private readonly maxAttempts = 5,
    private readonly retryBaseMs = 1_000,
    private readonly retryMaxMs = 60_000,
  ) {
    this.journal = new JsonlJournal<OutboxJournalEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const item of await this.journal.read()) {
      // A process can die after recording `sending` but before the platform
      // call returns. Treat that ambiguous item as pending on recovery.
      this.items.set(item.key, item.state === 'sending'
        ? { ...item, state: 'pending', nextAttemptAt: Date.now() }
        : item)
    }
    this.loaded = true
  }

  public async enqueue(input: Omit<OutboxItem, 'id' | 'state' | 'attempts' | 'createdAt' | 'updatedAt' | 'nextAttemptAt'> & { key: string }): Promise<OutboxItem> {
    await this.load()
    const existing = this.items.get(input.key)
    if (existing && existing.state !== 'dead') return { ...existing }
    const now = Date.now()
    const item: OutboxItem = {
      id: randomUUID(),
      key: input.key,
      state: 'pending',
      target: input.target,
      text: input.text,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    }
    this.items.set(item.key, item)
    await this.journal.append(item)
    if (this.active) void this.drainLane(laneKey(item.target))
    return { ...item }
  }

  public async get(key: string): Promise<OutboxItem | undefined> {
    await this.load()
    const item = this.items.get(key)
    return item && { ...item }
  }

  public async pendingCount(): Promise<number> {
    await this.load()
    return [...this.items.values()].filter(item => item.state === 'pending' || item.state === 'sending').length
  }

  public async snapshot(): Promise<OutboxItem[]> {
    await this.load()
    return [...this.items.values()].map(item => ({ ...item }))
  }

  public async flush(): Promise<void> {
    await this.load()
    const lanes = new Set([...this.items.values()].map(item => laneKey(item.target)))
    await Promise.all([...lanes].map(lane => this.drainLane(lane)))
  }

  /** Allow a DSH lifecycle restart to reuse the durable queue safely. */
  public start(): void {
    this.active = true
  }

  public async stop(): Promise<void> {
    this.active = false
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.lanes.values()])
  }

  private async drainLane(lane: string): Promise<void> {
    const current = this.lanes.get(lane)
    if (current) return current
    const run = this.runLane(lane).finally(() => {
      if (this.lanes.get(lane) === run) this.lanes.delete(lane)
    })
    this.lanes.set(lane, run)
    return run
  }

  private async runLane(lane: string): Promise<void> {
    while (this.active) {
      await this.load()
      const item = [...this.items.values()]
        .filter(candidate => laneKey(candidate.target) === lane && candidate.state === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!item) return
      const waitMs = Math.max(0, item.nextAttemptAt - Date.now())
      if (waitMs > 0) {
        await this.delay(waitMs)
        if (!this.active) return
      }
      const sending: OutboxItem = {
        ...item,
        state: 'sending',
        attempts: item.attempts + 1,
        updatedAt: Date.now(),
      }
      await this.record(sending)
      try {
        await this.sender(sending)
        await this.record({ ...sending, state: 'sent', updatedAt: Date.now() })
      } catch (error: unknown) {
        const exhausted = sending.attempts >= this.maxAttempts
        const failed: OutboxItem = {
          ...sending,
          state: exhausted ? 'dead' : 'pending',
          lastError: String(error),
          updatedAt: Date.now(),
          nextAttemptAt: exhausted
            ? Number.MAX_SAFE_INTEGER
            : Date.now() + this.backoff(sending.attempts),
        }
        await this.record(failed)
        if (exhausted) return
      }
    }
  }

  private async record(item: OutboxItem): Promise<void> {
    this.items.set(item.key, item)
    await this.journal.append(item)
  }

  private backoff(attempt: number): number {
    const exponential = this.retryBaseMs * 2 ** Math.max(0, attempt - 1)
    return Math.min(this.retryMaxMs, exponential)
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(finish)
        if (timer) this.timers.delete(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        finish()
      }, ms)
      this.waiters.add(finish)
      // Keep this timer referenced: callers of flush() await the retry, and
      // an unref'ed timer can let Node's test runner exit with that Promise
      // still pending. stop() clears all retry timers during shutdown.
      this.timers.add(timer)
      if (!this.active) finish()
    })
  }
}

export function isTerminalOutboxState(state: OutboxState): boolean {
  return state === 'sent' || state === 'dead'
}
