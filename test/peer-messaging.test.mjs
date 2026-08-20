import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotMailbox } from '../dist/collaboration.js'
import {
  PeerMessageValidationError,
  createPeerEnvelope,
  forwardPeerMessage,
  peerMessageIdempotencyKey,
} from '../dist/peer-messaging.js'

function input(overrides = {}) {
  return {
    from: { id: 'user:feishu:ou_test', type: 'user' },
    to: { id: 'researcher', type: 'bot' },
    taskId: 'task_test',
    runId: 'run_test',
    attemptId: 'attempt_test',
    correlationId: 'corr_test',
    payload: { instruction: 'review the plan' },
    ...overrides,
  }
}

test('Peer Message v1 normalizes addresses and tracing fields', () => {
  const envelope = createPeerEnvelope(input({ createdAt: 1_000 }))
  assert.equal(envelope.schemaVersion, 1)
  assert.equal(envelope.fromAddress?.type, 'user')
  assert.equal(envelope.toAddress?.id, 'researcher')
  assert.equal(envelope.conversationId, 'corr_test')
  assert.equal(envelope.traceId, 'corr_test')
  assert.equal(envelope.hop, 0)
  assert.equal(envelope.maxHops, 4)
  assert.equal(envelope.expiresAt, 1_000 + 30 * 60 * 1_000)
  assert.ok(envelope.idempotencyKey?.startsWith('peer:'))
  assert.equal(peerMessageIdempotencyKey(envelope), envelope.idempotencyKey)
})

test('Peer Message v1 enforces TTL, hops, and credential-like payload boundaries', () => {
  assert.throws(
    () => createPeerEnvelope(input({ createdAt: 1_000, expiresAt: 1_000 + 24 * 60 * 60 * 1_000 + 1 })),
    PeerMessageValidationError,
  )
  assert.throws(
    () => createPeerEnvelope(input({ payload: { apiKey: 'not allowed' } })),
    /credential-like/u,
  )
  assert.throws(
    () => createPeerEnvelope(input({ hop: 2, maxHops: 1 })),
    /hop/u,
  )
  assert.throws(
    () => createPeerEnvelope(
      input({ payload: { data: 'x'.repeat(1_025) } }),
      { peerMaxPayloadBytes: 1_024 },
    ),
    /payload/u,
  )
})

test('forwarding preserves trace identity and rejects a loop beyond maxHops', () => {
  const source = createPeerEnvelope(input({ createdAt: Date.now(), maxHops: 1 }))
  const forwarded = forwardPeerMessage(
    source,
    { id: 'researcher', type: 'bot' },
    { id: 'reviewer', type: 'bot' },
  )
  assert.equal(forwarded.hop, 1)
  assert.equal(forwarded.maxHops, 1)
  assert.equal(forwarded.replyTo, source.id)
  assert.equal(forwarded.traceId, source.traceId)
  assert.throws(
    () => forwardPeerMessage(
      forwarded,
      { id: 'reviewer', type: 'bot' },
      { id: 'writer', type: 'bot' },
    ),
    /maxHops/u,
  )
})

test('explicit idempotency and TTL use the existing durable mailbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-peer-message-'))
  try {
    const base = Date.now()
    const mailbox = new BotMailbox(join(root, 'mailbox.jsonl'))
    const first = createPeerEnvelope(input({
      createdAt: base,
      idempotencyKey: 'peer:test:one',
      ttlMs: 1_000,
    }))
    const duplicate = createPeerEnvelope(input({
      createdAt: base,
      idempotencyKey: 'peer:test:one',
      ttlMs: 1_000,
      runId: 'run_duplicate',
      attemptId: 'attempt_duplicate',
    }))
    await mailbox.enqueue(first, peerMessageIdempotencyKey(first), base)
    const existing = await mailbox.getByIdempotencyKey('peer:test:one')
    assert.equal(existing?.envelope.id, first.id)
    const deduped = await mailbox.enqueue(duplicate, peerMessageIdempotencyKey(duplicate), base)
    assert.equal(deduped.id, first.id)
    assert.equal((await mailbox.recoverExpired(base + 1_001))[0]?.lastError, 'message TTL expired')
    const reloaded = new BotMailbox(join(root, 'mailbox.jsonl'))
    assert.equal((await reloaded.getByIdempotencyKey('peer:test:one'))?.state, 'dead-letter')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects malformed runtime addresses, non-object roots, cyclic payloads and invalid epochs with typed errors', () => {
  assert.throws(
    () => createPeerEnvelope(input({ from: { id: 42, type: 'user' } })),
    PeerMessageValidationError,
  )
  assert.throws(
    () => createPeerEnvelope(input({ payload: [] })),
    PeerMessageValidationError,
  )
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(
    () => createPeerEnvelope(input({ payload: cyclic })),
    PeerMessageValidationError,
  )
  assert.throws(
    () => createPeerEnvelope(input({ epoch: -1 })),
    PeerMessageValidationError,
  )
})
