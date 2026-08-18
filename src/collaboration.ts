import { randomUUID } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'

export type BotMessageKind = 'request' | 'report' | 'question' | 'handoff' | 'approval'
export type BotMessageState = 'queued' | 'claimed' | 'acknowledged' | 'running' | 'completed' | 'failed' | 'dead-letter'

export interface BotAddress {
  readonly bot: string
  readonly sessionId?: string
}

export type BotMessagePayload = Readonly<Record<string, unknown>>

export interface BotMessageEnvelope {
  readonly id: string
  readonly idempotencyKey: string
  readonly kind: BotMessageKind
  readonly from: BotAddress
  readonly to: BotAddress
  readonly taskId?: string
  readonly runId?: string
  readonly attemptId?: string
  readonly correlationId: string
  readonly replyTo?: string
  readonly expectReply: boolean
  readonly payload: BotMessagePayload
  readonly createdAt: number
  readonly ttlMs?: number
  readonly state: BotMessageState
  readonly attempts: number
  readonly claimedBy?: string
  readonly lastError?: string
  readonly result?: BotMessagePayload
  readonly completedAt?: number
  readonly updatedAt: number
}

export interface SendBotMessageInput {
  readonly idempotencyKey?: string
  readonly kind: BotMessageKind
  readonly from: BotAddress
  readonly to: BotAddress
  readonly taskId?: string
  readonly runId?: string
  readonly attemptId?: string
  readonly correlationId?: string
  readonly replyTo?: string
  readonly expectReply?: boolean
  readonly payload: BotMessagePayload
  readonly ttlMs?: number
}

export interface BotMessageResult {
  readonly text?: string
  readonly data?: BotMessagePayload
}

interface CollaborationSnapshotEvent {
  readonly kind: 'snapshot'
  readonly message: BotMessageEnvelope
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isTerminal(state: BotMessageState): boolean {
  return state === 'completed' || state === 'failed' || state === 'dead-letter'
}

export class CollaborationStore {
  private readonly journal: JsonlJournal<CollaborationSnapshotEvent>
  private readonly items = new Map<string, BotMessageEnvelope>()
  private readonly idempotency = new Map<string, string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  public constructor(
    file: string,
    private readonly maxAttempts = 3,
  ) {
    this.journal = new JsonlJournal<CollaborationSnapshotEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    if (this.loading) {
      await this.loading
      return
    }
    this.loading = (async () => {
      for (const event of await this.journal.read()) {
        if (event.kind !== 'snapshot') continue
        this.items.set(event.message.id, event.message)
        this.idempotency.set(event.message.idempotencyKey, event.message.id)
      }
      this.loaded = true
    })()
    await this.loading
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.load()
    let result!: T
    const next = this.mutationTail.then(async () => {
      result = await operation()
    })
    this.mutationTail = next.then(() => undefined, () => undefined)
    await next
    return result
  }

  private async persist(message: BotMessageEnvelope): Promise<void> {
    this.items.set(message.id, message)
    this.idempotency.set(message.idempotencyKey, message.id)
    await this.journal.append({ kind: 'snapshot', message: clone(message) })
  }

  public async enqueue(input: SendBotMessageInput): Promise<BotMessageEnvelope> {
    return this.withMutation(async () => {
      const key = input.idempotencyKey ?? randomUUID()
      const existingId = this.idempotency.get(key)
      if (existingId !== undefined) {
        const existing = this.items.get(existingId)
        if (existing !== undefined) return clone(existing)
      }
      const now = Date.now()
      const message: BotMessageEnvelope = {
        id: randomUUID(),
        idempotencyKey: key,
        kind: input.kind,
        from: clone(input.from),
        to: clone(input.to),
        correlationId: input.correlationId ?? randomUUID(),
        expectReply: input.expectReply ?? true,
        payload: clone(input.payload),
        createdAt: now,
        state: 'queued',
        attempts: 0,
        updatedAt: now,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      }
      await this.persist(message)
      return clone(message)
    })
  }

  public async get(id: string): Promise<BotMessageEnvelope | undefined> {
    await this.load()
    const message = this.items.get(id)
    return message === undefined ? undefined : clone(message)
  }

  public async pendingForBot(bot: string, now = Date.now()): Promise<BotMessageEnvelope[]> {
    await this.load()
    return [...this.items.values()]
      .filter(message => {
        if (message.state !== 'queued' || message.to.bot !== bot) return false
        return message.ttlMs === undefined || message.createdAt + message.ttlMs > now
      })
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(message => clone(message))
  }

  public async pending(now = Date.now()): Promise<BotMessageEnvelope[]> {
    await this.load()
    const bots = new Set([...this.items.values()].filter(message => message.state === 'queued').map(message => message.to.bot))
    const messages: BotMessageEnvelope[] = []
    for (const bot of bots) messages.push(...await this.pendingForBot(bot, now))
    return messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  public async snapshot(): Promise<BotMessageEnvelope[]> {
    await this.load()
    return [...this.items.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(message => clone(message))
  }

  public async counts(): Promise<Record<BotMessageState, number>> {
    await this.load()
    const result = {
      queued: 0,
      claimed: 0,
      acknowledged: 0,
      running: 0,
      completed: 0,
      failed: 0,
      'dead-letter': 0,
    } as Record<BotMessageState, number>
    for (const message of this.items.values()) {
      result[message.state] = (result[message.state] ?? 0) + 1
    }
    return result
  }

  public async claim(id: string, bot: string): Promise<BotMessageEnvelope | undefined> {
    return this.withMutation(async () => {
      const current = this.items.get(id)
      if (current === undefined || current.state !== 'queued' || current.to.bot !== bot) return undefined
      const now = Date.now()
      if (current.ttlMs !== undefined && current.createdAt + current.ttlMs <= now) {
        const { claimedBy: _claimedBy, ...withoutClaim } = current
        const expired: BotMessageEnvelope = {
          ...withoutClaim,
          state: 'dead-letter',
          lastError: 'message expired before delivery',
          updatedAt: now,
        }
        await this.persist(expired)
        return undefined
      }
      const next: BotMessageEnvelope = {
        ...current,
        state: 'claimed',
        claimedBy: bot,
        attempts: current.attempts + 1,
        updatedAt: now,
      }
      await this.persist(next)
      return clone(next)
    })
  }

  public async acknowledge(id: string, bot: string): Promise<BotMessageEnvelope | undefined> {
    return this.withMutation(async () => {
      const current = this.items.get(id)
      if (current === undefined || current.state !== 'claimed' || current.claimedBy !== bot) return undefined
      const next: BotMessageEnvelope = { ...current, state: 'acknowledged', updatedAt: Date.now() }
      await this.persist(next)
      return clone(next)
    })
  }

  public async start(id: string, bot: string): Promise<BotMessageEnvelope | undefined> {
    return this.withMutation(async () => {
      const current = this.items.get(id)
      if (current === undefined || (current.state !== 'claimed' && current.state !== 'acknowledged') || current.claimedBy !== bot) return undefined
      const next: BotMessageEnvelope = { ...current, state: 'running', updatedAt: Date.now() }
      await this.persist(next)
      return clone(next)
    })
  }

  public async complete(id: string, bot: string, result?: BotMessageResult | void): Promise<BotMessageEnvelope | undefined> {
    return this.withMutation(async () => {
      const current = this.items.get(id)
      if (current === undefined || isTerminal(current.state) || current.claimedBy !== bot) return undefined
      const { claimedBy: _claimedBy, lastError: _lastError, ...withoutClaim } = current
      const resultPayload = result === undefined
        ? undefined
        : {
            ...(result.data ?? {}),
            ...(result.text === undefined ? {} : { text: result.text }),
          }
      const next: BotMessageEnvelope = resultPayload === undefined
        ? { ...withoutClaim, state: 'completed', completedAt: Date.now(), updatedAt: Date.now() }
        : { ...withoutClaim, state: 'completed', result: resultPayload, completedAt: Date.now(), updatedAt: Date.now() }
      await this.persist(next)
      return clone(next)
    })
  }

  public async fail(id: string, bot: string, error: unknown, retry = true): Promise<BotMessageEnvelope | undefined> {
    return this.withMutation(async () => {
      const current = this.items.get(id)
      if (current === undefined || isTerminal(current.state) || current.claimedBy !== bot) return undefined
      const retryable = retry && current.attempts < Math.max(1, this.maxAttempts)
      const nextState: BotMessageState = retryable ? 'queued' : retry ? 'dead-letter' : 'failed'
      const { claimedBy: _claimedBy, result: _result, completedAt: _completedAt, ...withoutClaim } = current
      const next: BotMessageEnvelope = {
        ...withoutClaim,
        state: nextState,
        lastError: String(error),
        updatedAt: Date.now(),
      }
      await this.persist(next)
      return clone(next)
    })
  }
}

export interface CollaborationHubOptions {
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
  readonly autoRetry?: boolean
  readonly deliverReplies?: boolean
}

export type BotMessageExecutor = (message: BotMessageEnvelope) => Promise<BotMessageResult | void>

export class CollaborationHub {
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly autoRetry: boolean
  private readonly deliverReplies: boolean

  public constructor(
    private readonly store: CollaborationStore,
    private readonly executor: BotMessageExecutor,
    options: CollaborationHubOptions = {},
  ) {
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 1_000)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 60_000)
    this.autoRetry = options.autoRetry !== false
    this.deliverReplies = options.deliverReplies !== false
  }

  public async load(): Promise<void> {
    await this.store.load()
  }

  public async send(input: SendBotMessageInput): Promise<BotMessageEnvelope> {
    const message = await this.store.enqueue(input)
    void this.dispatchFor(message.to.bot).catch(() => undefined)
    return message
  }

  public async dispatchFor(bot: string): Promise<void> {
    const previous = this.lanes.get(bot) ?? Promise.resolve()
    let current!: Promise<void>
    current = previous
      .catch(() => undefined)
      .then(async () => {
        while (true) {
          const pending = await this.store.pendingForBot(bot)
          const message = pending[0]
          if (message === undefined) return
          const processed = await this.dispatch(message.id)
          if (processed?.state === 'queued') return
        }
      })
      .finally(() => {
        if (this.lanes.get(bot) === current) this.lanes.delete(bot)
      })
    this.lanes.set(bot, current)
    await current
  }

  public async dispatchPending(): Promise<void> {
    const pending = await this.store.pending()
    const bots = [...new Set(pending.map(message => message.to.bot))]
    await Promise.all(bots.map(bot => this.dispatchFor(bot)))
  }

  public async dispatch(id: string): Promise<BotMessageEnvelope | undefined> {
    const message = await this.store.get(id)
    if (message === undefined) return undefined
    const claimed = await this.store.claim(id, message.to.bot)
    if (claimed === undefined) return await this.store.get(id)
    try {
      const acknowledged = await this.store.acknowledge(id, claimed.to.bot)
      if (acknowledged === undefined) throw new Error('collaboration message acknowledgement failed')
      const running = await this.store.start(id, claimed.to.bot)
      if (running === undefined) throw new Error('collaboration message start failed')
      const result = await this.executor(running)
      const completed = await this.store.complete(id, running.to.bot, result)
      if (completed === undefined) throw new Error('collaboration message completion failed')
      if (result !== undefined && running.expectReply && this.deliverReplies) {
        const payload: BotMessagePayload = {
          ...(result.data ?? {}),
          ...(result.text === undefined ? {} : { text: result.text }),
        }
        const reply = await this.store.enqueue({
          idempotencyKey: 'reply:' + running.id,
          kind: 'report',
          from: running.to,
          to: running.from,
          correlationId: running.correlationId,
          replyTo: running.id,
          expectReply: false,
          payload,
        })
        void this.dispatchFor(reply.to.bot).catch(() => undefined)
      }
      return completed
    } catch (error) {
      const failed = await this.store.fail(id, claimed.to.bot, error, true)
      if (failed?.state === 'queued' && this.autoRetry) this.scheduleRetry(failed.to.bot, failed.attempts)
      return failed
    }
  }

  public async snapshot(): Promise<BotMessageEnvelope[]> {
    return this.store.snapshot()
  }

  public async counts(): Promise<Record<BotMessageState, number>> {
    return this.store.counts()
  }

  private scheduleRetry(bot: string, attempts: number): void {
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempts - 1))
    let timer: ReturnType<typeof setTimeout>
    timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      void this.dispatchFor(bot).catch(() => undefined)
    }, delay)
    timer.unref?.()
    this.retryTimers.add(timer)
  }
}
