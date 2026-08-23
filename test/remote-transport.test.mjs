import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HttpRemoteBotTransport,
  LoopbackRemoteTransport,
  RemoteDeliveryLedger,
  RemoteTransportValidationError,
  createRemoteTransportHandler,
  createRemoteTransportMessage,
  signRemoteTransportBody,
} from '../dist/remote-transport.js'
import { createPeerEnvelope } from '../dist/peer-messaging.js'

function envelope(overrides = {}) {
  return createPeerEnvelope({
    from: { id: 'bot:captain', type: 'bot' },
    to: { id: 'researcher', type: 'bot' },
    taskId: 'task_remote',
    runId: 'run_remote',
    attemptId: 'attempt_remote',
    correlationId: 'corr_remote',
    createdAt: 1_000,
    ttlMs: 20_000,
    payload: {
      instruction: 'review the remote task',
      requester: 'user:feishu:ou_test',
      replyTarget: { platform: 'feishu', chatId: 'oc_test', userId: 'ou_test', chatType: 'group' },
    },
    ...overrides,
  })
}

function requestFor(message, secret, overrides = {}) {
  const body = JSON.stringify(message)
  return new Request('https://remote.test/v1/bot-messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-node-id': message.sourceNodeId,
      'x-dsh-signature': signRemoteTransportBody(body, secret),
      ...overrides,
    },
    body,
  })
}

test('remote transport messages carry correlation, lease, and fencing fields', () => {
  const message = createRemoteTransportMessage({
    envelope: envelope(),
    sourceNodeId: 'node-a',
    targetNodeId: 'node-b',
    leaseId: 'lease-a',
    fencingToken: 7,
    deliveryId: 'delivery-a',
    issuedAt: 2_000,
    leaseMs: 10_000,
  })
  assert.equal(message.schemaVersion, 1)
  assert.equal(message.correlationId, 'corr_remote')
  assert.equal(message.fencingToken, 7)
  assert.equal(message.expiresAt, 12_000)
  assert.equal(message.envelope.to, 'researcher')
})

test('HTTP handler authenticates, durably fences, and deduplicates deliveries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-remote-transport-'))
  try {
    const secret = 'remote-secret-for-tests'
    const calls = []
    const ledger = new RemoteDeliveryLedger(join(root, 'remote-inbox.jsonl'))
    const handler = createRemoteTransportHandler(async message => {
      calls.push(message.deliveryId)
      return { accepted: true, deliveryId: message.deliveryId, leaseUntil: message.expiresAt }
    }, { sharedSecret: secret, ledger, now: () => 2_500 })
    const message = createRemoteTransportMessage({
      envelope: envelope(),
      sourceNodeId: 'node-a',
      targetNodeId: 'node-b',
      leaseId: 'lease-a',
      fencingToken: 2,
      deliveryId: 'delivery-a',
      issuedAt: 2_000,
      leaseMs: 10_000,
    })
    const first = await handler(requestFor(message, secret))
    assert.equal(first.status, 202)
    assert.deepEqual(await first.json(), {
      accepted: true,
      deliveryId: 'delivery-a',
      leaseUntil: 12_000,
    })
    const duplicate = await handler(requestFor(message, secret))
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).duplicate, true)
    assert.deepEqual(calls, ['delivery-a'])

    const stale = createRemoteTransportMessage({
      envelope: envelope(),
      sourceNodeId: 'node-a',
      targetNodeId: 'node-b',
      leaseId: 'lease-old',
      fencingToken: 1,
      deliveryId: 'delivery-old',
      issuedAt: 2_000,
      leaseMs: 10_000,
    })
    const staleResponse = await handler(requestFor(stale, secret))
    assert.equal(staleResponse.status, 409)
    assert.equal((await staleResponse.json()).errorCode, 'stale-fence')

    const badSignature = await handler(requestFor(message, 'wrong-remote-secret'))
    assert.equal(badSignature.status, 401)
    assert.equal((await badSignature.json()).errorCode, 'invalid-signature')

    const reloaded = new RemoteDeliveryLedger(join(root, 'remote-inbox.jsonl'))
    assert.equal((await reloaded.snapshot()).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTP sender and loopback transport use the same signed receipt contract', async () => {
  const secret = 'remote-secret-for-tests'
  const delivered = []
  const handler = createRemoteTransportHandler(async message => {
    delivered.push(message.envelope.id)
    return { accepted: true, deliveryId: message.deliveryId }
  }, { sharedSecret: secret, now: () => 2_500 })
  const sender = new HttpRemoteBotTransport({
    endpoint: 'https://remote.test/v1/bot-messages',
    nodeId: 'node-a',
    sharedSecret: secret,
    fetch: async (_url, init) => handler(new Request('https://remote.test/v1/bot-messages', init)),
  })
  const message = createRemoteTransportMessage({
    envelope: envelope(),
    sourceNodeId: 'node-a',
    targetNodeId: 'node-b',
    deliveryId: 'delivery-http',
    issuedAt: 2_000,
    leaseMs: 10_000,
  })
  const receipt = await sender.send(message)
  assert.equal(receipt.accepted, true)
  assert.deepEqual(delivered, [message.envelope.id])

  const loopback = new LoopbackRemoteTransport(async input => ({
    accepted: true,
    deliveryId: input.deliveryId,
  }), { now: () => 2_500 })
  const loopReceipt = await loopback.send(message)
  assert.equal(loopReceipt.accepted, true)
  const duplicate = await loopback.send(message)
  assert.equal(duplicate.duplicate, true)
  await loopback.close()
  await assert.rejects(() => loopback.send(message), /closed/u)
})

test('remote transport rejects oversized and credential-like envelopes', () => {
  assert.throws(() => createRemoteTransportMessage({
    envelope: envelope({ payload: { instruction: 'x'.repeat(70_000), apiKey: 'blocked' } }),
    sourceNodeId: 'node-a',
    targetNodeId: 'node-b',
  }), RemoteTransportValidationError)
})
