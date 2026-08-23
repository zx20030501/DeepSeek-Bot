import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { withMockSession } from './mock-agent.mjs'

const target = { platform: 'feishu', chatId: 'oc_wf', chatType: 'dm', userId: 'ou_user' }

async function waitUntil(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

async function makeChatGateway(root, profiles) {
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
  const gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
    stateDir: root,
    access: { userIds: ['ou_user'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles,
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      features: { savedWorkflows: true, peerMessaging: true },
    },
  })
  let inbound
  const sent = []
  gateway.transports = [{
    platform: 'feishu',
    async start(handler) { inbound = handler },
    async stop() {},
    async send(destination, text) { sent.push({ target: destination, text }) },
  }]
  gateway.transportByPlatform.set('feishu', gateway.transports[0])
  await gateway.start()
  return {
    gateway,
    sent,
    async command(text) {
      await inbound({
        id: 'wf-cmd-' + Date.now(),
        target,
        text,
        receivedAt: Date.now(),
      })
    },
  }
}

function chatWorkflow() {
  return {
    name: 'Chat flow',
    description: 'created in chat',
    ownerId: 'user:feishu:ou_user',
    scope: 'user',
    entryNodeId: 'start',
    inputs: [],
    outputs: [],
    nodes: [
      { id: 'start', label: 'Start', kind: 'task', capability: 'start', outputs: ['result'] },
      { id: 'finish', label: 'Finish', kind: 'task', capability: 'work', outputs: ['result'] },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    policy: {
      budget: { maxDepth: 8, maxParallel: 2, maxFanOut: 2, maxMessages: 20, maxTokens: 20_000, maxCostUnits: 100 },
      allowedCapabilities: ['start', 'work'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
}

test('/wf list, export, run and import drive saved Workflows end to end in chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-chat-'))
  let source
  let destination
  try {
    source = await makeChatGateway(join(root, 'source'), {
      starter: { capabilities: ['start'] },
      worker: { capabilities: ['work'] },
    })
    const created = await source.gateway.createWorkflowDefinition(chatWorkflow(), 'user:feishu:ou_user')

    await source.command('/wf list')
    await waitUntil(() => source.sent.some(item => item.text.includes('已保存的 Workflow')))
    assert.ok(source.sent.some(item => item.text.includes(created.id)))

    await source.command('/wf export ' + created.id)
    await waitUntil(() => source.sent.some(item => item.text.includes('Workflow 清单')))
    const exportEntry = source.sent.find(item => item.text.includes('Workflow 清单'))
    const manifest = JSON.parse(exportEntry.text.split('\n').slice(1).join('\n'))
    assert.equal(manifest.workflow.id, created.id)
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/u)

    await source.command('/wf run ' + created.id)
    await waitUntil(() => source.sent.some(item => item.text.includes('已启动 Workflow')))
    assert.match(source.sent.find(item => item.text.includes('已启动 Workflow')).text, /已分发节点/u)

    // Import the exported manifest into a fresh gateway through chat.
    destination = await makeChatGateway(join(root, 'destination'), {
      starter: { capabilities: ['start'] },
      worker: { capabilities: ['work'] },
    })
    await destination.command('/wf import ' + JSON.stringify(manifest))
    await waitUntil(() => destination.sent.some(item => item.text.includes('已导入 Workflow')))
    assert.match(destination.sent.find(item => item.text.includes('已导入 Workflow')).text, /Chat flow/u)
    const imported = await destination.gateway.listWorkflowDefinitions('user:feishu:ou_user')
    assert.ok(imported.some(workflow => workflow.name === 'Chat flow' && workflow.nodes.length === 2))
  } finally {
    if (destination) await destination.gateway.stop()
    if (source) await source.gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
