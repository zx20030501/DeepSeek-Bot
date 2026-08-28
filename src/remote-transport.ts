import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { JsonlJournal } from './jsonl.js'
import { validatePeerEnvelope } from './peer-messaging.js'
import type { BotMessageEnvelope } from './types.js'

export const REMOTE_TRANSPORT_SCHEMA_VERSION = 1 as const

const DEFAULT_LEASE_MS = 120_000
const MAX_LEASE_MS = 30 * 60_000
const MAX_PAYLOAD_BYTES = 512 * 1_024
const MAX_CLOCK_SKEW_MS = 5 * 60_000

export interface RemoteTransportPolicyInput {
  readonly defaultLeaseMs?: number
  readonly maxLeaseMs?: number
  readonly maxPayloadBytes?: number
  readonly clockSkewMs?: number
}

export interface RemoteTransportPolicy {
  readonly defaultLeaseMs: number
  readonly maxLeaseMs: number
  readonly maxPayloadBytes: number
  readonly clockSkewMs: number
}

export interface RemoteBotTransportMessage {
  readonly schemaVersion: 1
  readonly deliveryId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly leaseId: string
  /** Monotonically increasing fence for a logical delivery key. */
  readonly fencingToken: number
  readonly correlationId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly envelope: BotMessageEnvelope
}

export interface RemoteTransportReceipt {
  readonly accepted: boolean
  readonly deliveryId: string
  readonly duplicate?: boolean
  readonly leaseUntil?: number
  readonly errorCode?: string
}

export class RemoteTransportError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'RemoteTransportError'
  }
}

export class RemoteTransportValidationError extends RemoteTransportError {
  public constructor(code: string, message: string) {
    super(code, message)
    this.name = 'RemoteTransportValidationError'
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(minimum, Math.min(maximum, selected))
}

export function normalizeRemoteTransportPolicy(
  input: RemoteTransportPolicyInput = {},
): RemoteTransportPolicy {
  const maxLeaseMs = bounded(input.maxLeaseMs, MAX_LEASE_MS, 1_000, MAX_LEASE_MS)
  return {
    defaultLeaseMs: bounded(input.defaultLeaseMs, DEFAULT_LEASE_MS, 1_000, maxLeaseMs),
    maxLeaseMs,
    maxPayloadBytes: bounded(input.maxPayloadBytes, MAX_PAYLOAD_BYTES, 1_024, MAX_PAYLOAD_BYTES),
    clockSkewMs: bounded(input.clockSkewMs, 30_000, 0, MAX_CLOCK_SKEW_MS),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredString(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RemoteTransportValidationError('invalid-' + field, field + ' must be a non-empty string')
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw new RemoteTransportValidationError('invalid-' + field, field + ' is too long')
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new RemoteTransportValidationError('invalid-' + field, field + ' contains a control character')
  }
  return normalized
}

function integer(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RemoteTransportValidationError('invalid-' + field, field + ' must be a safe integer in range')
  }
  return value
}

function envelopeFrom(value: unknown, policy: RemoteTransportPolicy): BotMessageEnvelope {
  try {
    return validatePeerEnvelope(value, { peerMaxPayloadBytes: policy.maxPayloadBytes })
  } catch (error: unknown) {
    throw new RemoteTransportValidationError(
      'invalid-envelope',
      error instanceof Error ? error.message : 'envelope.payload failed Peer Message validation',
    )
  }
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new RemoteTransportValidationError('invalid-message', 'message could not be serialized')
  }
  return Buffer.byteLength(serialized, 'utf8')
}

export interface RemoteBotTransportMessageInput {
  readonly envelope: BotMessageEnvelope
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly leaseId?: string
  readonly fencingToken?: number
  readonly deliveryId?: string
  readonly issuedAt?: number
  readonly leaseMs?: number
  readonly expiresAt?: number
}

export function createRemoteTransportMessage(
  input: RemoteBotTransportMessageInput,
  rawPolicy: RemoteTransportPolicyInput = {},
): RemoteBotTransportMessage {
  const policy = normalizeRemoteTransportPolicy(rawPolicy)
  const sourceNodeId = requiredString(input.sourceNodeId, 'sourceNodeId', 128)
  const targetNodeId = requiredString(input.targetNodeId, 'targetNodeId', 128)
  const leaseId = requiredString(input.leaseId ?? 'lease_' + randomUUID(), 'leaseId', 256)
  const deliveryId = requiredString(input.deliveryId ?? 'delivery_' + randomUUID(), 'deliveryId', 256)
  const fencingToken = input.fencingToken ?? 1
  integer(fencingToken, 'fencingToken', 0)
  const issuedAt = input.issuedAt ?? Date.now()
  integer(issuedAt, 'issuedAt', 0)
  const requestedExpiresAt = input.expiresAt ?? issuedAt + (input.leaseMs ?? policy.defaultLeaseMs)
  integer(requestedExpiresAt, 'expiresAt', issuedAt + 1)
  const maxExpiresAt = issuedAt + policy.maxLeaseMs
  if (requestedExpiresAt > maxExpiresAt) {
    throw new RemoteTransportValidationError('lease-exceeded', 'remote delivery lease exceeds the protocol maximum')
  }
  const envelope = envelopeFrom(input.envelope, policy)
  const expiresAt = envelope.expiresAt === undefined
    ? requestedExpiresAt
    : Math.min(requestedExpiresAt, envelope.expiresAt)
  if (expiresAt <= issuedAt) {
    throw new RemoteTransportValidationError('message-expired', 'remote delivery expires before it can be sent')
  }
  const message: RemoteBotTransportMessage = {
    schemaVersion: REMOTE_TRANSPORT_SCHEMA_VERSION,
    deliveryId,
    sourceNodeId,
    targetNodeId,
    leaseId,
    fencingToken,
    correlationId: envelope.correlationId,
    issuedAt,
    expiresAt,
    envelope,
  }
  if (serializedBytes(message) > policy.maxPayloadBytes) {
    throw new RemoteTransportValidationError('message-too-large', 'remote delivery exceeds the configured payload limit')
  }
  return message
}

export function validateRemoteTransportMessage(
  value: unknown,
  rawPolicy: RemoteTransportPolicyInput = {},
): RemoteBotTransportMessage {
  const policy = normalizeRemoteTransportPolicy(rawPolicy)
  const input = record(value)
  if (!input || input.schemaVersion !== REMOTE_TRANSPORT_SCHEMA_VERSION) {
    throw new RemoteTransportValidationError('unsupported-schema', 'unsupported remote transport schema')
  }
  const deliveryId = requiredString(input.deliveryId, 'deliveryId', 256)
  const sourceNodeId = requiredString(input.sourceNodeId, 'sourceNodeId', 128)
  const targetNodeId = requiredString(input.targetNodeId, 'targetNodeId', 128)
  const leaseId = requiredString(input.leaseId, 'leaseId', 256)
  const fencingToken = integer(input.fencingToken, 'fencingToken', 0)
  const correlationId = requiredString(input.correlationId, 'correlationId')
  const issuedAt = integer(input.issuedAt, 'issuedAt', 0)
  const expiresAt = integer(input.expiresAt, 'expiresAt', issuedAt + 1)
  if (expiresAt - issuedAt > policy.maxLeaseMs) {
    throw new RemoteTransportValidationError('lease-exceeded', 'remote delivery lease exceeds the protocol maximum')
  }
  const envelope = envelopeFrom(input.envelope, policy)
  if (envelope.correlationId !== correlationId) {
    throw new RemoteTransportValidationError('correlation-mismatch', 'remote correlationId must match envelope.correlationId')
  }
  if (envelope.expiresAt !== undefined && expiresAt > envelope.expiresAt) {
    throw new RemoteTransportValidationError('envelope-expiry-mismatch', 'remote delivery cannot outlive its Peer Message envelope')
  }
  const message: RemoteBotTransportMessage = {
    schemaVersion: REMOTE_TRANSPORT_SCHEMA_VERSION,
    deliveryId,
    sourceNodeId,
    targetNodeId,
    leaseId,
    fencingToken,
    correlationId,
    issuedAt,
    expiresAt,
    envelope,
  }
  if (serializedBytes(message) > policy.maxPayloadBytes) {
    throw new RemoteTransportValidationError('message-too-large', 'remote delivery exceeds the configured payload limit')
  }
  return message
}

function secretValue(secret: string): string {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new RemoteTransportError('shared-secret-invalid', 'remote transport shared secret must contain at least 16 characters')
  }
  return secret
}

export function signRemoteTransportBody(body: string, sharedSecret: string): string {
  return createHmac('sha256', secretValue(sharedSecret)).update(body, 'utf8').digest('hex')
}

export function verifyRemoteTransportSignature(body: string, signature: string, sharedSecret: string): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/u.test(signature)) return false
  const expected = signRemoteTransportBody(body, sharedSecret)
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
}

export interface RemoteTransportReceiver {
  (message: RemoteBotTransportMessage): Promise<RemoteTransportReceipt>
}

interface RemoteLedgerEntry {
  readonly key: string
  readonly sourceNodeId: string
  readonly idempotencyKey: string
  readonly fencingToken: number
  readonly leaseId: string
  readonly deliveryId: string
  readonly state: 'reserved' | 'accepted'
  readonly updatedAt: number
  /** Optional on old inbox rows; new rows always record their direction. */
  readonly direction?: 'inbound' | 'outbound'
  readonly message?: RemoteBotTransportMessage
}

interface RemoteLedgerEvent {
  readonly kind: 'reserved' | 'accepted'
  readonly entry: RemoteLedgerEntry
}

export interface RemoteFenceDecision {
  readonly decision: 'accepted' | 'duplicate' | 'stale'
  readonly entry: RemoteLedgerEntry
}

function ledgerKey(message: RemoteBotTransportMessage, direction: 'inbound' | 'outbound' = 'inbound'): string {
  return direction + ':' + message.sourceNodeId + ':' + (message.envelope.idempotencyKey ?? message.envelope.id)
}

function outboundLedgerKey(sourceNodeId: string, idempotencyKey: string): string {
  return 'outbound:' + sourceNodeId + ':' + idempotencyKey
}

function cloneLedgerEntry(entry: RemoteLedgerEntry): RemoteLedgerEntry {
  return {
    ...entry,
    ...(entry.message === undefined ? {} : { message: structuredClone(entry.message) }),
  }
}

/**
 * Durable remote inbox fence. A higher fencing token supersedes an older
 * attempt for the same source/idempotency key; the accepted marker is only
 * written after the Gateway has durably enqueued the local mailbox item.
 *
 * The same journal also stores outbound reservations when a caller supplies an
 * explicit idempotency key. That closes the send -> journal commit gap without
 * putting credentials into the Bot payload.
 */
export class RemoteDeliveryLedger {
  private readonly journal: JsonlJournal<RemoteLedgerEvent>
  private readonly entries = new Map<string, RemoteLedgerEntry>()
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  public constructor(file: string) {
    this.journal = new JsonlJournal<RemoteLedgerEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    for (const event of await this.journal.read()) {
      if (event.entry) {
        const entry = event.entry
        this.entries.set(entry.key, {
          ...entry,
          ...(entry.direction === undefined ? { direction: 'inbound' as const } : {}),
        })
      }
    }
    this.loaded = true
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T
    const current = this.tail
      .catch(() => undefined)
      .then(async () => { result = await operation() })
      .then(() => undefined)
    this.tail = current
    await current
    return result
  }

  public async admit(message: RemoteBotTransportMessage): Promise<RemoteFenceDecision> {
    return this.serialize(async () => {
      await this.load()
      const key = ledgerKey(message, 'inbound')
      const current = this.entries.get(key)
      if (current !== undefined) {
        if (current.fencingToken > message.fencingToken) return { decision: 'stale', entry: cloneLedgerEntry(current) }
        if (current.fencingToken === message.fencingToken) {
          if (current.leaseId !== message.leaseId || current.deliveryId !== message.deliveryId) {
            return { decision: 'stale', entry: cloneLedgerEntry(current) }
          }
          if (current.state === 'accepted') return { decision: 'duplicate', entry: cloneLedgerEntry(current) }
        }
      }
      const entry: RemoteLedgerEntry = {
        key,
        sourceNodeId: message.sourceNodeId,
        idempotencyKey: message.envelope.idempotencyKey ?? message.envelope.id,
        fencingToken: message.fencingToken,
        leaseId: message.leaseId,
        deliveryId: message.deliveryId,
        state: 'reserved',
        direction: 'inbound',
        updatedAt: Date.now(),
      }
      await this.journal.append({ kind: 'reserved', entry })
      this.entries.set(key, entry)
      return { decision: 'accepted', entry: cloneLedgerEntry(entry) }
    })
  }

  public async commit(message: RemoteBotTransportMessage, at = Date.now()): Promise<void> {
    await this.serialize(async () => {
      await this.load()
      const key = ledgerKey(message, 'inbound')
      const current = this.entries.get(key)
      if (
        current === undefined
        || current.fencingToken !== message.fencingToken
        || current.leaseId !== message.leaseId
        || current.deliveryId !== message.deliveryId
      ) return
      const entry: RemoteLedgerEntry = {
        ...current,
        direction: 'inbound',
        state: 'accepted',
        updatedAt: at,
      }
      await this.journal.append({ kind: 'accepted', entry })
      this.entries.set(key, entry)
    })
  }

  /** Return a reserved/sent outbound message for a caller-provided idempotency key. */
  public async getOutbound(
    sourceNodeId: string,
    idempotencyKey: string,
  ): Promise<RemoteBotTransportMessage | undefined> {
    await this.tail
    await this.load()
    const entry = this.entries.get(outboundLedgerKey(sourceNodeId, idempotencyKey))
    if (entry?.direction !== 'outbound' || entry.message === undefined) return undefined
    return structuredClone(entry.message)
  }

  public async isOutboundAccepted(sourceNodeId: string, idempotencyKey: string): Promise<boolean> {
    await this.tail
    await this.load()
    const entry = this.entries.get(outboundLedgerKey(sourceNodeId, idempotencyKey))
    return entry?.direction === 'outbound' && entry.state === 'accepted'
  }

  /** Reserve an outbound message before the network call. */
  public async reserveOutbound(message: RemoteBotTransportMessage): Promise<RemoteBotTransportMessage> {
    return this.serialize(async () => {
      await this.load()
      const key = ledgerKey(message, 'outbound')
      const current = this.entries.get(key)
      if (current?.direction === 'outbound' && current.message !== undefined) {
        return structuredClone(current.message)
      }
      const entry: RemoteLedgerEntry = {
        key,
        sourceNodeId: message.sourceNodeId,
        idempotencyKey: message.envelope.idempotencyKey ?? message.envelope.id,
        fencingToken: message.fencingToken,
        leaseId: message.leaseId,
        deliveryId: message.deliveryId,
        state: 'reserved',
        direction: 'outbound',
        message: structuredClone(message),
        updatedAt: Date.now(),
      }
      await this.journal.append({ kind: 'reserved', entry })
      this.entries.set(key, entry)
      return structuredClone(message)
    })
  }

  /**
   * Renew a reserved outbound delivery after its transport lease expires.
   * The logical envelope/idempotency key stays stable, while the delivery ID,
   * lease ID, and fencing token advance so a receiver can reject the stale
   * attempt without rejecting the retry itself.
   */
  public async renewOutbound(
    message: RemoteBotTransportMessage,
    at = Date.now(),
    rawPolicy: RemoteTransportPolicyInput = {},
  ): Promise<RemoteBotTransportMessage> {
    return this.serialize(async () => {
      await this.load()
      const key = ledgerKey(message, 'outbound')
      const current = this.entries.get(key)
      if (current?.direction === 'outbound' && current.message !== undefined) {
        if (current.state === 'accepted') return structuredClone(current.message)
        const baseline = current.message
        const renewed = createRemoteTransportMessage({
          envelope: baseline.envelope,
          sourceNodeId: baseline.sourceNodeId,
          targetNodeId: baseline.targetNodeId,
          fencingToken: Math.max(current.fencingToken, baseline.fencingToken, message.fencingToken) + 1,
          issuedAt: at,
          leaseMs: normalizeRemoteTransportPolicy(rawPolicy).defaultLeaseMs,
        }, rawPolicy)
        const entry: RemoteLedgerEntry = {
          ...current,
          fencingToken: renewed.fencingToken,
          leaseId: renewed.leaseId,
          deliveryId: renewed.deliveryId,
          state: 'reserved',
          message: structuredClone(renewed),
          updatedAt: at,
        }
        await this.journal.append({ kind: 'reserved', entry })
        this.entries.set(key, entry)
        return structuredClone(renewed)
      }
      const renewed = createRemoteTransportMessage({
        envelope: message.envelope,
        sourceNodeId: message.sourceNodeId,
        targetNodeId: message.targetNodeId,
        fencingToken: message.fencingToken + 1,
        issuedAt: at,
        leaseMs: normalizeRemoteTransportPolicy(rawPolicy).defaultLeaseMs,
      }, rawPolicy)
      const entry: RemoteLedgerEntry = {
        key,
        sourceNodeId: renewed.sourceNodeId,
        idempotencyKey: renewed.envelope.idempotencyKey ?? renewed.envelope.id,
        fencingToken: renewed.fencingToken,
        leaseId: renewed.leaseId,
        deliveryId: renewed.deliveryId,
        state: 'reserved',
        direction: 'outbound',
        message: structuredClone(renewed),
        updatedAt: at,
      }
      await this.journal.append({ kind: 'reserved', entry })
      this.entries.set(key, entry)
      return structuredClone(renewed)
    })
  }

  public async commitOutbound(message: RemoteBotTransportMessage, at = Date.now()): Promise<void> {
    await this.serialize(async () => {
      await this.load()
      const key = ledgerKey(message, 'outbound')
      const current = this.entries.get(key)
      if (
        current?.direction !== 'outbound'
        || current.message === undefined
        || current.fencingToken !== message.fencingToken
        || current.leaseId !== message.leaseId
        || current.deliveryId !== message.deliveryId
      ) return
      const entry: RemoteLedgerEntry = { ...current, state: 'accepted', updatedAt: at }
      await this.journal.append({ kind: 'accepted', entry })
      this.entries.set(key, entry)
    })
  }

  public async snapshot(): Promise<readonly RemoteFenceDecision[]> {
    await this.tail
    await this.load()
    return [...this.entries.values()].map(entry => ({
      decision: entry.state === 'accepted' ? 'duplicate' : 'accepted',
      entry: cloneLedgerEntry(entry),
    }))
  }
}

export interface HttpRemoteTransportOptions extends RemoteTransportPolicyInput {
  readonly endpoint: string
  readonly nodeId: string
  readonly sharedSecret: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

function responseJson(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function receiptFrom(value: unknown, fallbackDeliveryId: string): RemoteTransportReceipt {
  const input = record(value)
  if (!input || typeof input.accepted !== 'boolean') {
    throw new RemoteTransportError('invalid-receipt', 'remote endpoint returned an invalid receipt')
  }
  const deliveryId = requiredString(input.deliveryId ?? fallbackDeliveryId, 'receipt.deliveryId')
  return {
    accepted: input.accepted,
    deliveryId,
    ...(input.duplicate === true ? { duplicate: true } : {}),
    ...(typeof input.leaseUntil === 'number' ? { leaseUntil: input.leaseUntil } : {}),
    ...(typeof input.errorCode === 'string' ? { errorCode: input.errorCode } : {}),
  }
}

/**
 * HTTP sender. The request body is signed exactly as sent; the receiver must
 * use createRemoteTransportHandler with the same secret.
 */
export class HttpRemoteBotTransport {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly policy: RemoteTransportPolicy

  public constructor(private readonly options: HttpRemoteTransportOptions) {
    this.policy = normalizeRemoteTransportPolicy(options)
    this.timeoutMs = bounded(options.timeoutMs, 30_000, 1_000, 120_000)
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (fetchImpl === undefined) throw new RemoteTransportError('fetch-unavailable', 'global fetch is unavailable')
    this.fetchImpl = fetchImpl
    requiredString(options.endpoint, 'endpoint', 2_048)
    requiredString(options.nodeId, 'nodeId', 128)
    secretValue(options.sharedSecret)
  }

  public async send(message: RemoteBotTransportMessage): Promise<RemoteTransportReceipt> {
    const checked = validateRemoteTransportMessage(message, this.policy)
    if (checked.sourceNodeId !== this.options.nodeId) {
      throw new RemoteTransportError('source-node-mismatch', 'message.sourceNodeId does not match the configured sender node')
    }
    const body = JSON.stringify(checked)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-node-id': this.options.nodeId,
          'x-dsh-delivery-id': checked.deliveryId,
          'x-dsh-fencing-token': String(checked.fencingToken),
          'x-dsh-signature': signRemoteTransportBody(body, this.options.sharedSecret),
        },
        body,
        signal: controller.signal,
      })
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        parsed = undefined
      }
      const receipt = receiptFrom(parsed, checked.deliveryId)
      if (!response.ok || receipt.accepted !== true) {
        throw new RemoteTransportError(
          receipt.errorCode ?? 'remote-rejected',
          'remote endpoint rejected delivery',
          response.status,
        )
      }
      if (receipt.deliveryId !== checked.deliveryId) {
        throw new RemoteTransportError('receipt-mismatch', 'remote receipt deliveryId does not match request')
      }
      return receipt
    } catch (error: unknown) {
      if (error instanceof RemoteTransportError) throw error
      throw new RemoteTransportError('remote-send-failed', String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  public async close(): Promise<void> {}
}

export interface RemoteTransportHandlerOptions extends RemoteTransportPolicyInput {
  readonly sharedSecret: string
  readonly ledger?: RemoteDeliveryLedger
  readonly now?: () => number
}

export function createRemoteTransportHandler(
  receiver: RemoteTransportReceiver,
  options: RemoteTransportHandlerOptions,
): (request: Request) => Promise<Response> {
  const policy = normalizeRemoteTransportPolicy(options)
  const sharedSecret = secretValue(options.sharedSecret)
  const now = options.now ?? (() => Date.now())
  return async request => {
    if (request.method !== 'POST') return responseJson(405, { accepted: false, errorCode: 'method-not-allowed' })
    const body = await request.text()
    if (Buffer.byteLength(body, 'utf8') > policy.maxPayloadBytes) {
      return responseJson(413, { accepted: false, errorCode: 'message-too-large' })
    }
    const signature = request.headers.get('x-dsh-signature')
    if (signature === null || !verifyRemoteTransportSignature(body, signature, sharedSecret)) {
      return responseJson(401, { accepted: false, errorCode: 'invalid-signature' })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body) as unknown
    } catch {
      return responseJson(400, { accepted: false, errorCode: 'invalid-json' })
    }
    let message: RemoteBotTransportMessage
    try {
      message = validateRemoteTransportMessage(parsed, policy)
    } catch (error: unknown) {
      const code = error instanceof RemoteTransportError ? error.code : 'invalid-message'
      return responseJson(400, { accepted: false, errorCode: code })
    }
    const claimedSourceNode = request.headers.get('x-dsh-node-id')
    if (claimedSourceNode !== null && claimedSourceNode !== message.sourceNodeId) {
      return responseJson(400, { accepted: false, errorCode: 'source-node-mismatch' })
    }
    const claimedDeliveryId = request.headers.get('x-dsh-delivery-id')
    if (claimedDeliveryId !== null && claimedDeliveryId !== message.deliveryId) {
      return responseJson(400, { accepted: false, errorCode: 'delivery-id-mismatch' })
    }
    const claimedFencingToken = request.headers.get('x-dsh-fencing-token')
    if (claimedFencingToken !== null) {
      const parsedFencingToken = Number(claimedFencingToken)
      if (!/^\d+$/u.test(claimedFencingToken) || !Number.isSafeInteger(parsedFencingToken) || parsedFencingToken !== message.fencingToken) {
        return responseJson(400, { accepted: false, errorCode: 'fencing-token-mismatch' })
      }
    }
    const currentTime = now()
    if (message.issuedAt > currentTime + policy.clockSkewMs) {
      return responseJson(400, { accepted: false, errorCode: 'issued-in-future' })
    }
    if (message.envelope.createdAt > currentTime + policy.clockSkewMs) {
      return responseJson(400, { accepted: false, errorCode: 'envelope-issued-in-future' })
    }
    if (message.expiresAt + policy.clockSkewMs <= currentTime) {
      return responseJson(410, { accepted: false, errorCode: 'message-expired' })
    }
    if (message.envelope.expiresAt !== undefined && message.envelope.expiresAt + policy.clockSkewMs <= currentTime) {
      return responseJson(410, { accepted: false, errorCode: 'envelope-expired' })
    }
    const ledger = options.ledger
    if (ledger !== undefined) {
      const decision = await ledger.admit(message)
      if (decision.decision === 'stale') {
        return responseJson(409, { accepted: false, deliveryId: message.deliveryId, errorCode: 'stale-fence' })
      }
      if (decision.decision === 'duplicate') {
        return responseJson(200, { accepted: true, duplicate: true, deliveryId: message.deliveryId, leaseUntil: message.expiresAt })
      }
    }
    try {
      const receipt = await receiver(message)
      if (receipt.accepted !== false) {
        await ledger?.commit(message)
        return responseJson(receipt.duplicate === true ? 200 : 202, receipt)
      }
      return responseJson(409, receipt)
    } catch {
      return responseJson(500, { accepted: false, deliveryId: message.deliveryId, errorCode: 'receiver-failed' })
    }
  }
}

export interface LoopbackRemoteTransportOptions extends RemoteTransportPolicyInput {
  readonly now?: () => number
}

export class LoopbackRemoteTransport {
  private readonly policy: RemoteTransportPolicy
  private readonly now: () => number
  private readonly delivered = new Map<string, RemoteTransportReceipt>()
  private closed = false

  public constructor(
    private readonly receiver: RemoteTransportReceiver,
    options: LoopbackRemoteTransportOptions = {},
  ) {
    this.policy = normalizeRemoteTransportPolicy(options)
    this.now = options.now ?? (() => Date.now())
  }

  public async send(message: RemoteBotTransportMessage): Promise<RemoteTransportReceipt> {
    if (this.closed) throw new RemoteTransportError('transport-closed', 'loopback transport is closed')
    const checked = validateRemoteTransportMessage(message, this.policy)
    const key = checked.sourceNodeId + ':' + (checked.envelope.idempotencyKey ?? checked.envelope.id)
    const existing = this.delivered.get(key)
    if (existing !== undefined) return { ...existing, duplicate: true }
    const now = this.now()
    if (checked.issuedAt > now + this.policy.clockSkewMs) {
      throw new RemoteTransportError('issued-in-future', 'remote delivery was issued too far in the future')
    }
    if (checked.envelope.createdAt > now + this.policy.clockSkewMs) {
      throw new RemoteTransportError('envelope-issued-in-future', 'remote Peer Message was issued too far in the future')
    }
    if (checked.expiresAt + this.policy.clockSkewMs <= now) throw new RemoteTransportError('message-expired', 'remote delivery has expired')
    if (checked.envelope.expiresAt !== undefined && checked.envelope.expiresAt + this.policy.clockSkewMs <= now) {
      throw new RemoteTransportError('envelope-expired', 'remote Peer Message has expired')
    }
    const receipt = await this.receiver(checked)
    if (receipt.accepted !== false) this.delivered.set(key, receipt)
    return receipt
  }

  public async close(): Promise<void> {
    this.closed = true
  }
}
