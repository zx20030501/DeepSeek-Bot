import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { BotDirectory } from '../dist/collaboration.js'
import { emitMockAgentEvent, withMockSession } from './mock-agent.mjs'

const target = { platform: 'feishu', chatId: 'oc_scale', chatType: 'dm', userId: 'ou_a' }

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

function thousandProfiles() {
  const profiles = {}
  for (let index = 0; index < 1_000; index += 1) {
    profiles[`logical-${String(index).padStart(3, '0')}`] = {
      title: `Logical Bot ${index}`,
      capabilities: index === 999 ? ['capability-999', 'zebra-tail'] : [`capability-${index}`],
    }
  }
  profiles['alpha-report'] = { capabilities: ['alpha-report'] }
  profiles['beta-report'] = { capabilities: ['beta-report'] }
  return profiles
}

function makeAgentRegistry(behaviours = {}) {
  const agents = new Map()
  const created = []
  let gatewayRef = () => { throw new Error('not attached') }
  const registry = {
    get(id) { return agents.get(String(id)) },
    async resume() { throw new Error('not found') },
    async create({ sessionId, meta }) {
      const preset = meta?.agentPreset ?? 'unknown'
      const agent = withMockSession({
        id: String(sessionId),
        status: 'idle',
        cancel() {},
        followup() {
          const behaviour = behaviours[preset]
          if (behaviour === undefined) return
          behaviour(gatewayRef(), agent)
        },
      })
      agents.set(String(sessionId), agent)
      created.push({ preset, agent })
      return { agent }
    },
  }
  return { registry, created, attach(gateway) { gatewayRef = () => gateway } }
}

test('capability index resolves candidates instantly at 1000 logical Bots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-scale-index-'))
  let gateway
  try {
    const kit = makeAgentRegistry()
    gateway = new BotGateway({ get: name => name === 'agents' ? kit.registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: thousandProfiles(),
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        managerBotId: 'manager',
        features: { managerAgent: true, peerMessaging: true },
      },
    })
    gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
    gateway.transportByPlatform.set('feishu', gateway.transports[0])
    kit.attach(gateway)
    await gateway.start()

    const directory = gateway.directory
    assert.equal(directory.capabilityCount(), 1_003)
    assert.deepEqual([...directory.botsWithCapability('capability-999')], ['logical-999'])
    assert.deepEqual([...directory.botsWithCapability('capability-0')], ['logical-000'])
    assert.deepEqual([...directory.botsWithCapability('missing-capability')], [])
    // Substring fallback preserves the legacy matching semantics.
    assert.deepEqual([...directory.botsWithCapability('report')].sort(), ['alpha-report', 'beta-report'])

    // Manager planning resolves the correct logical Bot through the roster.
    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_a',
      replyTarget: target,
      instruction: 'Use the 999th capability',
      requiredCapabilities: ['zebra-tail'],
      maxAssignments: 1,
    })
    assert.equal(planned.dispatched.length, 1)
    assert.equal(planned.dispatched[0].to, 'logical-999')

    const plannedReport = await gateway.planManagerTask({
      requester: 'user:feishu:ou_a',
      replyTarget: target,
      instruction: 'Produce a report',
      requiredCapabilities: ['report'],
      maxAssignments: 2,
    })
    assert.deepEqual(plannedReport.dispatched.map(envelope => envelope.to).sort(), ['alpha-report', 'beta-report'])
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('BotDirectory backs capability lookups with an index (pure unit)', () => {
  const directory = new BotDirectory([{
    name: 'worker-a',
    capabilities: ['alpha', 'report'],
    enabled: true,
  }, {
    name: 'worker-b',
    capabilities: ['beta'],
    enabled: true,
  }, {
    name: 'disabled-x',
    capabilities: ['alpha'],
    enabled: false,
  }])
  assert.equal(directory.capabilityCount(), 3)
  assert.deepEqual([...directory.botsWithCapability('alpha')], ['worker-a'])
  assert.deepEqual([...directory.botsWithCapability('report')], ['worker-a'])
  assert.deepEqual([...directory.botsWithCapability('beta')], ['worker-b'])
})

test('per-user quota applies backpressure: one active run per requester', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-scale-quota-'))
  let gateway
  try {
    const kit = makeAgentRegistry() // no behaviours: runs never complete
    gateway = new BotGateway({ get: name => name === 'agents' ? kit.registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a', 'ou_b'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        'bot-a1': { capabilities: ['work'] },
        'bot-a2': { capabilities: ['work'] },
        'bot-b1': { capabilities: ['work'] },
      },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        perUserMaxRuns: 1,
        maxParallelRuns: 6,
        features: { peerMessaging: true },
      },
    })
    gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
    gateway.transportByPlatform.set('feishu', gateway.transports[0])
    kit.attach(gateway)
    await gateway.start()

    const targetA = { platform: 'feishu', chatId: 'oc_a', chatType: 'dm', userId: 'ou_a' }
    const targetB = { platform: 'feishu', chatId: 'oc_b', chatType: 'dm', userId: 'ou_b' }
    await gateway.sendBotMessage({ from: 'user:feishu:ou_a', to: 'bot-a1', instruction: 'first', replyTarget: targetA })
    await gateway.sendBotMessage({ from: 'user:feishu:ou_a', to: 'bot-a2', instruction: 'second', replyTarget: targetA })
    await gateway.sendBotMessage({ from: 'user:feishu:ou_b', to: 'bot-b1', instruction: 'third', replyTarget: targetB })

    await waitUntil(async () => {
      const snapshot = await gateway.tasks.snapshot()
      const b1Run = snapshot.runs.filter(run => run.botId === 'bot-b1' && (run.status === 'queued' || run.status === 'running'))
      return b1Run.length >= 1
    }, 2_000)
    // Wait for the steady state: exactly one in-flight run per requester.
    await waitUntil(async () => {
      const snapshot = await gateway.tasks.snapshot()
      const aRunning = snapshot.runs.filter(run => (run.botId === 'bot-a1' || run.botId === 'bot-a2') && run.status === 'running')
      const aQueued = snapshot.runs.filter(run => (run.botId === 'bot-a1' || run.botId === 'bot-a2') && run.status === 'queued')
      const bRunning = snapshot.runs.filter(run => run.botId === 'bot-b1' && run.status === 'running')
      return aRunning.length === 1 && aQueued.length === 1 && bRunning.length === 1
    }, 4_000)
    const snapshot = await gateway.tasks.snapshot()
    const aRunning = snapshot.runs.filter(run => (run.botId === 'bot-a1' || run.botId === 'bot-a2') && run.status === 'running')
    const aQueued = snapshot.runs.filter(run => (run.botId === 'bot-a1' || run.botId === 'bot-a2') && run.status === 'queued')
    const bRunning = snapshot.runs.filter(run => run.botId === 'bot-b1' && run.status === 'running')
    assert.equal(aRunning.length, 1, 'user A may keep at most one active run')
    assert.equal(aQueued.length, 1, 'user A second run waits in the queue (backpressure)')
    assert.equal(bRunning.length, 1, 'user B is not blocked by user A')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('idle direct-chat sessions are reaped and their agents stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-scale-idle-'))
  let gateway
  try {
    const kit = makeAgentRegistry({
      // Direct chat binds the auto-added default profile, not `botx`.
      default: (gatewayRef, agent) => {
        emitMockAgentEvent(gatewayRef, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi there' }] } })
        emitMockAgentEvent(gatewayRef, agent, 'turn/end', { reason: { kind: 'completed' } })
      },
    })
    gateway = new BotGateway({ get: name => name === 'agents' ? kit.registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: { botx: { capabilities: ['chat'] } },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        sessionIdleTimeoutMs: 200,
        sessionIdleCheckMs: 80,
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
    kit.attach(gateway)
    await gateway.start()

    await inbound({
      id: 'idle-1',
      target: { platform: 'feishu', chatId: 'oc_a', chatType: 'dm', userId: 'ou_a' },
      text: 'hello bot',
      receivedAt: Date.now(),
    })
    await waitUntil(() => kit.created.length >= 1, 2_000)

    await waitUntil(async () => {
      const snapshot = await gateway.tasks.snapshot()
      return snapshot.audits.some(audit => audit.action === 'session.idle_reaped')
    }, 5_000)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
