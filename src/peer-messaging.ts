import { createHash } from 'node:crypto'
import { createEnvelope } from './collaboration.js'
import type {
  BotAddress,
  BotAddressType,
  BotCollaborationConfig,
  BotMessageEnvelope,
  BotMessageKind,
} from './types.js'

export const PEER_MESSAGE_SCHEMA_VERSION = 1 as const

export interface PeerMessagePolicy {
  readonly defaultTtlMs: number
  readonly maxTtlMs: number
  readonly maxHops: number
  readonly maxPayloadBytes: number
}

const MAX_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_HOPS = 8
const MAX_PAYLOAD_BYTES = 256 * 1024

export class PeerMessageValidationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PeerMessageValidationError'
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(minimum, Math.min(maximum, selected))
}

function reference(value: string, field: string, maximum = 256): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new PeerMessageValidationError('invalid-reference', field + ' must not be empty')
  if (normalized.length > maximum) throw new PeerMessageValidationError('invalid-reference', field + ' is too long')
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new PeerMessageValidationError('invalid-reference', field + ' contains a control character')
  }
  return normalized
}

function normalizeAddress(input: BotAddress, field: string): BotAddress {
  if (input === null || typeof input !== 'object') {
    throw new PeerMessageValidationError('invalid-address', field + ' must be an address object')
  }
  const id = reference(input.id, field + '.id')
  const type: BotAddressType = input.type
    ?? (id.startsWith('user:') ? 'user' : id.startsWith('system:') ? 'system' : 'bot')
  if (!['user', 'bot', 'system', 'service'].includes(type)) {
    throw new PeerMessageValidationError('invalid-address', field + '.type is not supported')
  }
  return {
    id,
    type,
    ...(input.sessionId === undefined ? {} : { sessionId: reference(input.sessionId, field + '.sessionId') }),
    ...(input.roomId === undefined ? {} : { roomId: reference(input.roomId, field + '.roomId') }),
    ...(input.threadId === undefined ? {} : { threadId: reference(input.threadId, field + '.threadId') }),
  }
}

const credentialKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|private[_-]?key)/iu
const credentialValue = /\b(?:sk|rk|ghp|xoxb|xapp)-[A-Za-z0-9_-]{12,}\b/iu
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu

function inspectValue(value: unknown, path: string, depth: number): void {
  if (depth > 8) throw new PeerMessageValidationError('payload-too-deep', 'payload nesting exceeds 8 levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && (credentialValue.test(value) || bearerValue.test(value))) {
      throw new PeerMessageValidationError('credential-like-payload', 'payload contains a credential-like value at ' + path)
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PeerMessageValidationError('invalid-payload', 'payload contains a non-finite number at ' + path)
    return
  }
  if (typeof value !== 'object') {
    throw new PeerMessageValidationError('invalid-payload', 'payload contains a non-JSON value at ' + path)
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new PeerMessageValidationError('payload-too-large', 'payload array is too large at ' + path)
    value.forEach((item, index) => inspectValue(item, path + '[' + index + ']', depth + 1))
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PeerMessageValidationError('invalid-payload', 'payload must contain plain JSON objects')
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (credentialKey.test(key) && item !== null && item !== undefined) {
      throw new PeerMessageValidationError('credential-like-payload', 'payload contains a credential-like field at ' + path + '.' + key)
    }
    inspectValue(item, path + '.' + key, depth + 1)
  }
}

export function validatePeerPayload(
  payload: Record<string, unknown>,
  maxBytes = MAX_PAYLOAD_BYTES,
): number {
  inspectValue(payload, '$', 0)
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) {
    throw new PeerMessageValidationError('invalid-payload', 'payload could not be serialized as JSON')
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  const limit = bounded(maxBytes, MAX_PAYLOAD_BYTES, 1_024, MAX_PAYLOAD_BYTES)
  if (bytes > limit) throw new PeerMessageValidationError('payload-too-large', 'payload exceeds ' + limit + ' UTF-8 bytes')
  return bytes
}

function clonePayload(payload: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) {
    throw new PeerMessageValidationError('invalid-payload', 'payload could not be serialized as JSON')
  }
  validatePeerPayload(payload, maxBytes)
  return JSON.parse(serialized) as Record<string, unknown>
}

export function normalizePeerPolicy(
  config: Pick<BotCollaborationConfig, 'peerMessageTtlMs' | 'peerMaxHops' | 'peerMaxPayloadBytes'> = {},
): PeerMessagePolicy {
  const defaultTtlMs = bounded(config.peerMessageTtlMs, 30 * 60 * 1_000, 1_000, MAX_TTL_MS)
  return {
    defaultTtlMs,
    maxTtlMs: MAX_TTL_MS,
    maxHops: bounded(config.peerMaxHops, 4, 0, MAX_HOPS),
    maxPayloadBytes: bounded(config.peerMaxPayloadBytes, 64 * 1_024, 1_024, MAX_PAYLOAD_BYTES),
  }
}

export interface PeerMessageInput {
  readonly kind?: BotMessageKind
  readonly from: BotAddress
  readonly to: BotAddress
  readonly taskId: string
  readonly runId: string
  readonly attemptId: string
  readonly correlationId?: string
  readonly conversationId?: string
  readonly replyTo?: string
  readonly traceId?: string
  readonly hop?: number
  readonly maxHops?: number
  readonly roomId?: string
  readonly epoch?: number
  readonly idempotencyKey?: string
  readonly ttlMs?: number
  readonly createdAt?: number
  readonly expiresAt?: number
  readonly payload: Record<string, unknown>
}

export function peerMessageIdempotencyKey(envelope: BotMessageEnvelope): string {
  if (envelope.idempotencyKey !== undefined) return envelope.idempotencyKey
  const canonical = JSON.stringify({
    from: envelope.from,
    to: envelope.to,
    taskId: envelope.taskId,
    runId: envelope.runId,
    attemptId: envelope.attemptId,
    kind: envelope.kind,
    correlationId: envelope.correlationId,
    conversationId: envelope.conversationId ?? envelope.correlationId,
    replyTo: envelope.replyTo ?? null,
    payload: envelope.payload,
  })
  return 'peer:' + createHash('sha256').update(canonical).digest('hex')
}

export function createPeerEnvelope(
  input: PeerMessageInput,
  rawPolicy: Pick<BotCollaborationConfig, 'peerMessageTtlMs' | 'peerMaxHops' | 'peerMaxPayloadBytes'> = {},
): BotMessageEnvelope {
  const policy = normalizePeerPolicy(rawPolicy)
  const from = normalizeAddress(input.from, 'from')
  const to = normalizeAddress(input.to, 'to')
  const taskId = reference(input.taskId, 'taskId')
  const runId = reference(input.runId, 'runId')
  const attemptId = reference(input.attemptId, 'attemptId')
  const correlationId = reference(input.correlationId ?? input.conversationId ?? taskId, 'correlationId')
  const conversationId = reference(input.conversationId ?? correlationId, 'conversationId')
  const traceId = reference(input.traceId ?? correlationId, 'traceId')
  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new PeerMessageValidationError('invalid-time', 'createdAt must be a non-negative integer')
  }
  if (input.ttlMs !== undefined && input.expiresAt !== undefined) {
    throw new PeerMessageValidationError('invalid-time', 'ttlMs and expiresAt are mutually exclusive')
  }
  const expiresAt = input.expiresAt
    ?? (input.ttlMs === undefined ? createdAt + policy.defaultTtlMs : createdAt + input.ttlMs)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) {
    throw new PeerMessageValidationError('invalid-time', 'expiresAt must be after createdAt')
  }
  if (expiresAt - createdAt > policy.maxTtlMs) {
    throw new PeerMessageValidationError('ttl-exceeded', 'message TTL exceeds the protocol maximum')
  }
  const maxHops = input.maxHops ?? policy.maxHops
  const hop = input.hop ?? 0
  if (!Number.isSafeInteger(maxHops) || maxHops < 0 || maxHops > policy.maxHops) {
    throw new PeerMessageValidationError('hop-limit-exceeded', 'maxHops exceeds the configured protocol limit')
  }
  if (!Number.isSafeInteger(hop) || hop < 0 || hop > maxHops) {
    throw new PeerMessageValidationError('hop-limit-exceeded', 'hop must be between zero and maxHops')
  }
  const idempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : reference(input.idempotencyKey, 'idempotencyKey')
  const payload = clonePayload(input.payload, policy.maxPayloadBytes)
  const base = createEnvelope({
    kind: input.kind ?? 'request',
    from: from.id,
    to: to.id,
    taskId,
    runId,
    attemptId,
    correlationId,
    schemaVersion: PEER_MESSAGE_SCHEMA_VERSION,
    fromAddress: from,
    toAddress: to,
    conversationId,
    ...(input.replyTo === undefined ? {} : { replyTo: reference(input.replyTo, 'replyTo') }),
    traceId,
    hop,
    maxHops,
    ...(input.roomId === undefined ? {} : { roomId: reference(input.roomId, 'roomId') }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    payload,
    createdAt,
    expiresAt,
  })
  return idempotencyKey === undefined
    ? { ...base, idempotencyKey: peerMessageIdempotencyKey(base) }
    : base
}

export function forwardPeerMessage(
  envelope: BotMessageEnvelope,
  from: BotAddress,
  to: BotAddress,
  payload?: Record<string, unknown>,
  rawPolicy: Pick<BotCollaborationConfig, 'peerMessageTtlMs' | 'peerMaxHops' | 'peerMaxPayloadBytes'> = {},
): BotMessageEnvelope {
  const nextHop = (envelope.hop ?? 0) + 1
  const maxHops = envelope.maxHops ?? normalizePeerPolicy(rawPolicy).maxHops
  if (nextHop > maxHops) {
    throw new PeerMessageValidationError('hop-limit-exceeded', 'forwarding would exceed maxHops')
  }
  return createPeerEnvelope({
    kind: envelope.kind,
    from,
    to,
    taskId: envelope.taskId,
    runId: envelope.runId,
    attemptId: envelope.attemptId,
    correlationId: envelope.correlationId,
    ...(envelope.conversationId === undefined ? {} : { conversationId: envelope.conversationId }),
    replyTo: envelope.id,
    traceId: envelope.traceId ?? envelope.correlationId,
    hop: nextHop,
    maxHops,
    ...(envelope.roomId === undefined ? {} : { roomId: envelope.roomId }),
    ...(envelope.epoch === undefined ? {} : { epoch: envelope.epoch }),
    ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt }),
    payload: payload ?? envelope.payload,
  }, rawPolicy)
}

export function isPeerMessage(envelope: BotMessageEnvelope): boolean {
  return envelope.schemaVersion === PEER_MESSAGE_SCHEMA_VERSION
    && envelope.fromAddress !== undefined
    && envelope.toAddress !== undefined
    && envelope.traceId !== undefined
    && envelope.hop !== undefined
    && envelope.maxHops !== undefined
}
