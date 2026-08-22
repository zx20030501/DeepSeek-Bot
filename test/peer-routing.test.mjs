import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { emitMockAgentEvent, withMockSession } from './mock-agent.mjs'

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for Peer Message route')
}

test('direct Bot output can route a bounded authorized @bot Peer Message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-peer-route-'))
  let gateway
  const created = []
  const sent = []
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, agentOptions, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {},
        })
        agents.set(String(sessionId), agent)
        created.push({ preset, agent })
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: { source: {}, target: {} },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        peerMaxHops: 2,
        features: { peerMessaging: true },
      },
    })
    const transport = {
      platform: 'feishu',
      async start() {},
      async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()

    const replyTarget = { platform: 'feishu', chatId: 'oc_peer', chatType: 'dm', userId: 'ou_user' }
    await gateway.sendBotMessage({
      from: 'user:feishu:ou_user',
      to: 'source',
      instruction: 'ask the target',
      replyTarget,
    })
    await waitUntil(() => created.some(item => item.preset === 'source'))
    const source = created.find(item => item.preset === 'source')?.agent
    assert.ok(source)

    emitMockAgentEvent(gateway, source, 'assistant/message', {
      message: { content: [{ type: 'text', text: '@target please review the source report' }] },
    })
    emitMockAgentEvent(gateway, source, 'turn/end', { reason: { kind: 'completed' } })

    await waitUntil(() => created.some(item => item.preset === 'target'))
    const target = created.find(item => item.preset === 'target')?.agent
    assert.ok(target)
    emitMockAgentEvent(gateway, target, 'assistant/message', {
      message: { content: [{ type: 'text', text: '@source target report' }] },
    })
    emitMockAgentEvent(gateway, target, 'turn/end', { reason: { kind: 'completed' } })

    await waitUntil(async () => {
      const status = await gateway.fleetStatus()
      return status.fleet.tasks.some(task => task.assignedTo === 'target' && task.status === 'completed')
    })
    const status = await gateway.fleetStatus()
    assert.ok(sent.some(item => item.text.includes('@target：')))
    assert.equal(status.fleet.tasks.filter(task => task.assignedTo === 'target').length, 1)
    assert.equal(status.fleet.tasks.filter(task => task.assignedTo === 'source').length, 1)
    assert.equal(status.fleet.tasks.filter(task => task.assignedTo === 'target')[0]?.status, 'completed')
    assert.equal(status.fleet.tasks.filter(task => task.assignedTo === 'source').length, 1)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('direct Bot output cannot route Peer Messages while the feature flag is off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-peer-route-disabled-'))
  let gateway
  const created = []
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          cancel() {},
          followup() {},
        })
        agents.set(String(sessionId), agent)
        created.push({ preset, agent })
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: { source: {}, target: {} },
      collaboration: { enabled: true, approvalMode: 'never' },
    })
    gateway.transports = [{
      platform: 'feishu',
      async start() {},
      async stop() {},
      async send() {},
    }]
    gateway.transportByPlatform.set('feishu', gateway.transports[0])
    await gateway.start()

    const replyTarget = { platform: 'feishu', chatId: 'oc_peer', chatType: 'dm', userId: 'ou_user' }
    await assert.rejects(() => gateway.sendBotMessage({
      from: 'source',
      fromAddress: { id: 'source', type: 'bot' },
      to: 'target',
      instruction: 'blocked structured peer request',
      replyTarget,
    }), /Peer Messaging is disabled/u)
    await gateway.sendBotMessage({
      from: 'user:feishu:ou_user',
      to: 'source',
      instruction: 'do not route the mention',
      replyTarget,
    })
    await waitUntil(() => created.some(item => item.preset === 'source'))
    const source = created.find(item => item.preset === 'source')?.agent
    assert.ok(source)
    emitMockAgentEvent(gateway, source, 'assistant/message', {
      message: { content: [{ type: 'text', text: '@target this must remain plain output' }] },
    })
    emitMockAgentEvent(gateway, source, 'turn/end', { reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.equal(created.some(item => item.preset === 'target'), false)
    const status = await gateway.fleetStatus()
    assert.equal(status.fleet.tasks.filter(task => task.assignedTo === 'target').length, 0)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
