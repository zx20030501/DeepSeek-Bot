import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboundWal, Outbox } from '../dist/durable.js'

function message(id = 'telegram:update:1') {
  return {
    id,
    updateId: '1',
    target: { platform: 'telegram', chatId: '42', userId: '7', chatType: 'dm' },
    text: 'hello',
    receivedAt: Date.now(),
  }
}

test('inbound WAL recovers a dispatched message after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hermes-wal-'))
  try {
    const file = join(root, 'inbound.jsonl')
    const wal = new InboundWal(file, 3)
    const accepted = await wal.accept(message())
    assert.equal(accepted.inserted, true)
    assert.equal(accepted.item.state, 'accepted')
    const duplicate = await wal.accept(message())
    assert.equal(duplicate.inserted, false)
    const claimed = await wal.claim(accepted.item.id, 'hermes-bot-session')
    assert.equal(claimed?.state, 'dispatched')

    const reloaded = new InboundWal(file, 3)
    const pending = await reloaded.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].sessionId, 'hermes-bot-session')
    await reloaded.complete(accepted.item.id)
    assert.equal((await reloaded.pending()).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inbound WAL keeps transient failures retryable until the attempt budget is exhausted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hermes-wal-retry-'))
  try {
    const file = join(root, 'inbound.jsonl')
    const wal = new InboundWal(file, 3)
    const accepted = await wal.accept(message('telegram:update:retry'))

    const firstClaim = await wal.claim(accepted.item.id, 'hermes-bot-session')
    const firstFailure = await wal.fail(accepted.item.id, new Error('temporary 1'))
    assert.equal(firstClaim?.attempts, 1)
    assert.equal(firstFailure?.state, 'accepted')
    assert.equal((await wal.pending()).length, 1)

    const secondClaim = await wal.claim(accepted.item.id, 'hermes-bot-session')
    await wal.fail(accepted.item.id, new Error('temporary 2'))
    assert.equal(secondClaim?.attempts, 2)

    const thirdClaim = await wal.claim(accepted.item.id, 'hermes-bot-session')
    const terminal = await wal.fail(accepted.item.id, new Error('final'))
    assert.equal(thirdClaim?.attempts, 3)
    assert.equal(terminal?.state, 'failed')
    assert.equal((await wal.pending()).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('outbox is idempotent by key and retries in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hermes-outbox-'))
  try {
    const calls = []
    let failures = 0
    const outbox = new Outbox(
      join(root, 'outbox.jsonl'),
      async item => {
        calls.push(item.text)
        if (failures++ === 0) throw new Error('temporary')
      },
      3,
      1,
      5,
    )
    const target = { platform: 'telegram', chatId: '42' }
    const first = await outbox.enqueue({ key: 'answer:1', target, text: 'first' })
    const duplicate = await outbox.enqueue({ key: 'answer:1', target, text: 'changed' })
    assert.equal(first.id, duplicate.id)
    await outbox.enqueue({ key: 'answer:2', target, text: 'second' })
    await outbox.flush()
    assert.deepEqual(calls, ['first', 'first', 'second'])
    assert.equal((await outbox.get('answer:1')).state, 'sent')
    assert.equal((await outbox.get('answer:2')).state, 'sent')
    await outbox.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
