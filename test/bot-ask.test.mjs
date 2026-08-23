import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { BotAskRegistry, askReplyIdempotencyKey } from '../dist/bot-ask.js'
import { withMockSession } from './mock-agent.mjs'

const replyTarget = { platform: 'feishu', chatId: 'oc_ask', chatType: 'dm', userId: 'ou_user' }

async function makeGateway(root, features = { peerMessaging: true }) {
  const agents = new Map()
  const registry = {
    get(id) { return agents.get(String(id)) },
    async resume() { throw new Error('not found') },
    async create({ sessionId, meta }) {
      const agent = withMockSession({
        id: String(sessionId),
        status: 'idle',
        cancel() {},
        followup() {},
      })
      agents.set(String(sessionId), agent)
      return { agent }
    },
  }
  const gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
    stateDir: root,
    access: { userIds: ['ou_user'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      asker: { capabilities: ['ask'] },
      answerer: { capabilities: ['answer'] },
      analyst: { capabilities: ['answer'] },
    },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      features,
    },
  })
  gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
  gateway.transportByPlatform.set('feishu', gateway.transports[0])
  await gateway.start()
  return gateway
}

test('botAsk delivers a durable Ask and botWait aggregates the reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-'))
  let gateway
  try {
    gateway = await makeGateway(root)
    const ask = await gateway.botAsk({
      from: 'asker',
      to: ['answerer'],
      question: 'What is the answer?',
      replyTarget,
    })
    assert.equal(ask.status, 'pending')
    assert.equal(ask.envelopes?.length, 1)
    const envelope = ask.envelopes[0]
    assert.equal(envelope.payload.askId, ask.askId)
    assert.equal(envelope.payload.__dshAsk, true)
    assert.equal(envelope.kind, 'request')

    const reply = await gateway.replyToMessage({
      message: envelope,
      from: 'answerer',
      instruction: 'forty-two',
      replyTarget,
    })
    assert.equal(reply.kind, 'reply')
    assert.equal(reply.payload.askId, ask.askId)
    assert.equal(reply.payload.__dshAsk, true)
    assert.equal(reply.idempotencyKey, askReplyIdempotencyKey(ask.askId, 'answerer'))

    const result = await gateway.botWait(ask.askId, { timeoutMs: 2_000 })
    assert.equal(result.status, 'answered')
    assert.equal(result.replies.length, 1)
    assert.equal(result.replies[0].from, 'answerer')
    assert.equal(result.replies[0].text, 'forty-two')
    assert.equal(result.timedOut, false)

    const status = await gateway.botAskStatus(ask.askId)
    assert.equal(status.status, 'answered')
    assert.equal(status.correlationId, ask.correlationId)

    const fleet = await gateway.fleetStatus()
    assert.equal(fleet.fleet.askCounts.answered >= 1, true)
    assert.ok(fleet.fleet.asks.some(item => item.askId === ask.askId && item.replyCount === 1))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('botAsk fan-out aggregates one reply per target and replaces retried replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-fanout-'))
  let gateway
  try {
    gateway = await makeGateway(root)
    const ask = await gateway.botAsk({
      from: 'asker',
      to: ['answerer', 'analyst'],
      question: 'Produce the weekly report',
      replyTarget,
    })
    assert.equal(ask.envelopes?.length, 2)
    const [toAnswerer, toAnalyst] = ask.envelopes
    assert.equal(toAnswerer.to, 'answerer')
    assert.equal(toAnalyst.to, 'analyst')

    await gateway.replyToMessage({ message: toAnswerer, from: 'answerer', instruction: 'a1', replyTarget })
    await gateway.replyToMessage({ message: toAnalyst, from: 'analyst', instruction: 'a2', replyTarget })
    let result = await gateway.botWait(ask.askId, { timeoutMs: 2_000 })
    assert.equal(result.status, 'answered')
    assert.equal(result.replies.length, 2)
    assert.deepEqual(result.replies.map(reply => reply.from).sort(), ['analyst', 'answerer'])

    // A retried reply from the same target replaces, not duplicates.
    await gateway.replyToMessage({ message: toAnswerer, from: 'answerer', instruction: 'a1-revised', replyTarget })
    result = await gateway.botAskStatus(ask.askId)
    assert.equal(result.replies.length, 2)
    assert.equal(result.replies.find(reply => reply.from === 'answerer').text, 'a1-revised')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('botWait honours the caller timeout while the Ask is still pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-timeout-'))
  let gateway
  try {
    gateway = await makeGateway(root)
    const ask = await gateway.botAsk({
      from: 'asker',
      to: ['answerer'],
      question: 'Slow question',
      replyTarget,
      ttlMs: 60_000,
    })
    const result = await gateway.botWait(ask.askId, { timeoutMs: 100, pollMs: 20 })
    assert.equal(result.status, 'pending')
    assert.equal(result.timedOut, true)
    assert.equal(result.replies.length, 0)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('BotAskRegistry expires, cancels, and recovers durably across reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-registry-'))
  const file = join(root, 'asks.jsonl')
  try {
    const first = new BotAskRegistry(file)
    const ask = await first.register({
      from: 'asker',
      to: ['answerer'],
      question: 'Persisted question',
      ttlMs: 60_000,
      teamId: 'team-1',
      threadId: 'thread-9',
    })
    await first.recordReply(ask.askId, { from: 'answerer', text: '42', messageId: 'm1' })
    assert.equal((await first.get(ask.askId)).status, 'answered')

    const pending = await first.register({ from: 'asker', to: ['analyst'], question: 'Expiring', ttlMs: 60_000 })
    const changed = await first.expire(Date.now() + 90_000)
    assert.equal(changed.some(record => record.askId === pending.askId && record.status === 'timed-out'), true)
    assert.equal((await first.wait(pending.askId, { timeoutMs: 100 })).status, 'timed-out')
    assert.equal(await first.cancel(pending.askId, 'obsolete'), undefined)

    const cancelled = await first.register({ from: 'asker', to: ['analyst'], question: 'Cancel me', ttlMs: 60_000 })
    assert.equal((await first.cancel(cancelled.askId, 'obsolete')).status, 'cancelled')

    // Recovery: a fresh registry over the same journal sees every transition.
    const second = new BotAskRegistry(file)
    await second.load()
    const loaded = await second.get(ask.askId)
    assert.equal(loaded.status, 'answered')
    assert.equal(loaded.replies.length, 1)
    assert.equal(loaded.replies[0].text, '42')
    assert.deepEqual([...loaded.to], ['answerer'])
    assert.equal(loaded.teamId, 'team-1')
    assert.equal(loaded.threadId, 'thread-9')
    assert.equal((await second.get(pending.askId)).status, 'timed-out')
    assert.equal((await second.get(cancelled.askId)).status, 'cancelled')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('chained asks correlate across teams via parentAskId and correlationId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-chain-'))
  let gateway
  try {
    gateway = await makeGateway(root)
    const outer = await gateway.botAsk({
      from: 'asker',
      to: ['answerer'],
      question: 'Summarize the incident',
      replyTarget,
      teamId: 'team-ops',
      threadId: 'thread-incident-7',
    })
    const inner = await gateway.botAsk({
      from: 'answerer',
      to: ['analyst'],
      question: 'Gather the raw metrics',
      replyTarget,
      parentAskId: outer.askId,
      teamId: 'team-ops',
      threadId: 'thread-incident-7',
      correlationId: outer.correlationId,
      traceId: outer.correlationId,
    })
    assert.equal(inner.correlationId === outer.correlationId, true, 'child ask inherits the parent trace')

    const innerEnvelope = inner.envelopes[0]
    await gateway.replyToMessage({ message: innerEnvelope, from: 'analyst', instruction: 'metrics: 42%', replyTarget })
    const innerResult = await gateway.botWait(inner.askId, { timeoutMs: 2_000 })
    assert.equal(innerResult.status, 'answered')

    const outerEnvelope = outer.envelopes[0]
    await gateway.replyToMessage({ message: outerEnvelope, from: 'answerer', instruction: 'Incident is under control', replyTarget })
    const outerResult = await gateway.botWait(outer.askId, { timeoutMs: 2_000 })
    assert.equal(outerResult.status, 'answered')
    assert.equal(outerResult.replies[0].text, 'Incident is under control')

    const fleet = await gateway.fleetStatus()
    const asks = fleet.fleet.asks
    assert.ok(asks.some(item => item.askId === inner.askId && item.parentAskId === outer.askId))
    assert.ok(asks.some(item => item.askId === outer.askId && item.teamId === 'team-ops' && item.threadId === 'thread-incident-7'))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('botAsk is rejected while Peer Messaging is disabled or the target is unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-guard-'))
  let gateway
  try {    gateway = await makeGateway(root, {})
    await assert.rejects(() => gateway.botAsk({
      from: 'asker',
      to: ['answerer'],
      question: 'blocked',
      replyTarget,
    }), /Peer Messaging is disabled/u)
    await gateway.stop()
    gateway = await makeGateway(root)
    await assert.rejects(() => gateway.botAsk({
      from: 'asker',
      to: ['ghost'],
      question: 'nobody',
      replyTarget,
    }), /Bot is unavailable or not authorized/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('/ask chat command asks a Bot and delivers the answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-ask-command-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, meta }) {
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          cancel() {},
          followup() {},
        })
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: { answerer: { capabilities: ['answer'] } },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        features: { peerMessaging: true },
      },
    })
    let inbound
    const sent = []
    gateway.transports = [{
      platform: 'feishu',
      async start(handler) { inbound = handler },
      async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }]
    gateway.transportByPlatform.set('feishu', gateway.transports[0])
    await gateway.start()

    await inbound({
      id: 'ask-cmd-1',
      target: { platform: 'feishu', chatId: 'oc_ask', chatType: 'dm', userId: 'ou_user' },
      text: '/ask @answerer What is the answer?',
      receivedAt: Date.now(),
    })

    // Confirmation is sent and the Ask is durably registered.
    let pending = []
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      pending = await gateway.askRegistry.pending()
      if (pending.length >= 1 && sent.some(item => item.text.includes('已向 @answerer 提问'))) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(pending.length, 1)
    assert.deepEqual([...pending[0].to], ['answerer'])
    assert.equal(pending[0].question, 'What is the answer?')
    const askId = pending[0].askId
    assert.ok(sent.some(item => item.text.includes('已向 @answerer 提问')))
    // The target Bot's reply completes the Ask; the /ask waiter delivers it.
    await gateway.askRegistry.recordReply(askId, { from: 'answerer', text: 'forty-two', messageId: 'reply-1' })

    const answerDeadline = Date.now() + 3_000
    while (Date.now() < answerDeadline && !sent.some(entry => entry.text.includes('forty-two'))) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.ok(sent.some(entry => entry.text.includes('forty-two')), 'the answer should be delivered to the chat')
    assert.ok(sent.some(entry => entry.text.includes(askId)))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
