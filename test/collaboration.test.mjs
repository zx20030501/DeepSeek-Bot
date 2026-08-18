import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CollaborationHub, CollaborationStore } from '../dist/collaboration.js'

function messageInput(overrides = {}) {
  return {
    idempotencyKey: 'default-message',
    kind: 'request',
    from: { bot: 'planner' },
    to: { bot: 'researcher' },
    payload: { instruction: 'collect evidence' },
    ...overrides,
  }
}

test('collaboration store persists idempotency and lifecycle transitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-'))
  const file = join(directory, 'collaboration.jsonl')
  const store = new CollaborationStore(file, 2)

  const first = await store.enqueue(messageInput({ idempotencyKey: 'lifecycle' }))
  const duplicate = await store.enqueue(messageInput({ idempotencyKey: 'lifecycle', payload: { instruction: 'different' } }))
  assert.equal(duplicate.id, first.id)

  const claimed = await store.claim(first.id, 'researcher')
  assert.equal(claimed?.state, 'claimed')
  assert.equal(claimed?.attempts, 1)
  assert.equal((await store.acknowledge(first.id, 'researcher'))?.state, 'acknowledged')
  assert.equal((await store.start(first.id, 'researcher'))?.state, 'running')
  assert.equal((await store.complete(first.id, 'researcher', { text: 'evidence ready' }))?.state, 'completed')

  const restored = new CollaborationStore(file, 2)
  await restored.load()
  const recovered = await restored.get(first.id)
  assert.equal(recovered?.state, 'completed')
  assert.equal(recovered?.result?.text, 'evidence ready')
  assert.match(await readFile(file, 'utf8'), /"kind":"snapshot"/)
})

test('collaboration hub delivers a typed report back to the sender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-'))
  const store = new CollaborationStore(join(directory, 'collaboration.jsonl'))
  const executed = []
  const hub = new CollaborationHub(store, async message => {
    executed.push(message)
    return { text: 'handled by ' + message.to.bot, data: { messageKind: message.kind } }
  }, { autoRetry: false })

  const request = await hub.send(messageInput({ idempotencyKey: 'hub-request' }))
  await hub.dispatchFor('researcher')
  const completed = await store.get(request.id)
  assert.equal(completed?.state, 'completed')
  assert.equal(completed?.result?.text, 'handled by researcher')

  await hub.dispatchFor('planner')
  const snapshot = await hub.snapshot()
  const report = snapshot.find(item => item.replyTo === request.id)
  assert.equal(report?.state, 'completed')
  assert.equal(report?.result?.text, 'handled by planner')
  assert.equal(executed.length, 2)
})

test('failed collaboration attempts are requeued and then dead-lettered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-collaboration-'))
  const store = new CollaborationStore(join(directory, 'collaboration.jsonl'), 2)
  const hub = new CollaborationHub(store, async () => {
    throw new Error('executor unavailable')
  }, { autoRetry: false })

  const request = await hub.send(messageInput({ idempotencyKey: 'retryable' }))
  await hub.dispatchFor('researcher')
  assert.equal((await store.get(request.id))?.state, 'queued')

  await hub.dispatchFor('researcher')
  const dead = await store.get(request.id)
  assert.equal(dead?.state, 'dead-letter')
  assert.equal(dead?.attempts, 2)
  assert.match(dead?.lastError ?? '', /executor unavailable/)
})
