import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { withMockSession } from './mock-agent.mjs'

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

test('/manager status reports Bot, Ask and Workflow summaries from the control plane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-command-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, meta }) {
        const agent = withMockSession({ id: String(sessionId), status: 'idle', cancel() {}, followup() {} })
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        'worker-a': { capabilities: ['alpha'] },
        'worker-b': { capabilities: ['beta'] },
      },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        features: { managerAgent: true, peerMessaging: true },
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

    await gateway.managerPause('worker-b', { reason: 'maintenance', actor: 'manager' })
    await inbound({
      id: 'manager-status-1',
      target: { platform: 'feishu', chatId: 'oc_mgr', chatType: 'dm', userId: 'ou_user' },
      text: '/manager status',
      receivedAt: Date.now(),
    })
    await waitUntil(() => sent.some(item => item.text.includes('Manager 状态')))
    const status = sent.find(item => item.text.includes('Manager 状态')).text
    assert.match(status, /@worker-a · available/u)
    assert.match(status, /@worker-b · unavailable · paused/u)
    assert.match(status, /\nBot：3/u, 'roster includes the auto-added default profile')
    assert.match(status, /Ask：0 待答/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
