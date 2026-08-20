import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import {
  compileManagerDispatches,
  compileWorkflowLaunch,
  managerDescriptorsFromRoster,
  workflowDispatchKey,
} from '../dist/fleet-runtime.js'
import { generateManagerPlan } from '../dist/manager-policy.js'

const target = {
  platform: 'feishu',
  chatId: 'oc_manager',
  chatType: 'dm',
  userId: 'ou_user',
}

function workflowDraft() {
  return {
    name: 'Research then write',
    description: 'A bounded two-stage workflow',
    ownerId: 'user:feishu:ou_user',
    scope: 'user',
    entryNodeId: 'research',
    inputs: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{
      name: 'answer',
      source: { kind: 'node-output', nodeId: 'write', output: 'result' },
    }],
    nodes: [
      {
        id: 'research',
        label: 'Research the topic',
        kind: 'task',
        capability: 'research',
        inputs: [{ name: 'topic', source: { kind: 'input', name: 'topic' } }],
        outputs: ['result'],
        messageBudget: 2,
        tokenBudget: 1_000,
        costUnits: 10,
      },
      {
        id: 'write',
        label: 'Write the final answer',
        kind: 'task',
        capability: 'write',
        inputs: [{ name: 'research', source: { kind: 'node-output', nodeId: 'research', output: 'result' } }],
        outputs: ['result'],
        messageBudget: 2,
        tokenBudget: 1_000,
        costUnits: 10,
      },
    ],
    edges: [{ from: 'research', to: 'write' }],
    policy: {
      budget: {
        maxDepth: 4,
        maxParallel: 2,
        maxFanOut: 2,
        maxMessages: 10,
        maxTokens: 10_000,
        maxCostUnits: 100,
      },
      allowedCapabilities: ['research', 'write'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
}

test('control-plane compiler keeps Manager dispatches bounded and typed', () => {
  const bots = [
    { id: 'researcher', profile: 'researcher', title: 'Researcher', capabilities: ['research'], skills: [], fleetRole: 'worker', sessionScope: 'requester', allowedUserIds: [], allowedChatIds: [], approvalRequired: false, canonicalSessionId: 's1', enabled: true },
    { id: 'writer', profile: 'writer', title: 'Writer', capabilities: ['write'], skills: [], fleetRole: 'worker', sessionScope: 'requester', allowedUserIds: [], allowedChatIds: [], approvalRequired: false, canonicalSessionId: 's2', enabled: true },
  ]
  const descriptors = managerDescriptorsFromRoster(bots, target, botId => botId === 'researcher')
  assert.equal(descriptors.find(bot => bot.id === 'researcher')?.authorized, true)
  assert.equal(descriptors.find(bot => bot.id === 'writer')?.authorized, false)
  const plan = generateManagerPlan({
    taskId: 'task-compiler',
    traceId: 'trace-compiler',
    requester: 'user:feishu:ou_user',
    instruction: 'research the topic',
    requiredCapabilities: ['research'],
    maxAssignments: 1,
  }, 'manager', descriptors)
  assert.equal(plan.policyDecision, 'allow')
  const dispatches = compileManagerDispatches(plan)
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0]?.to.id, 'researcher')
  assert.equal(dispatches[0]?.from.type, 'bot')
  assert.match(dispatches[0]?.idempotencyKey ?? '', /^manager:/u)
})

test('Workflow compiler preserves dependency order and stable launch keys', () => {
  const plan = compileWorkflowLaunch({
    schemaVersion: 1,
    id: 'wf_compiler',
    revision: 2,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...workflowDraft(),
  })
  assert.deepEqual(plan.nodeOrder, ['research', 'write'])
  assert.deepEqual(plan.entryTaskIds, ['research'])
  assert.deepEqual(plan.nodes.find(node => node.nodeId === 'write')?.dependsOn, ['research'])
  assert.equal(workflowDispatchKey('wf_compiler', 2, 'research'), workflowDispatchKey('wf_compiler', 2, 'research'))
})

test('Gateway rechecks ACL before Manager dispatch and persists Workflow definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-runtime-adapter-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager' },
    })
    const manager = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget: target,
      instruction: 'research this topic',
      requiredCapabilities: ['research'],
      maxAssignments: 1,
    })
    assert.equal(manager.plan.policyDecision, 'allow')
    assert.equal(manager.dispatched.length, 1)
    assert.equal((await gateway.fleetStatus()).fleet.mailbox.queued, 1)

    const workflow = await gateway.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const stored = await gateway.getWorkflowDefinition(workflow.id, 'user:feishu:ou_user')
    assert.equal(stored?.revision, 1)
    const launch = await gateway.launchWorkflowDefinition(workflow.id, 'user:feishu:ou_user', target, 'user:feishu:ou_user')
    assert.deepEqual(launch.entryNodes, ['research'])
    assert.equal(launch.dispatched.length, 1)
    const detail = await gateway.fleetTaskDetail(manager.taskId, 'local-dashboard')
    assert.equal(detail?.deliveries.length, 1)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Manager approval gates dispatch and resumes through the durable approval path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-approval-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'auto-planned', managerBotId: 'manager' },
    })
    const result = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget: target,
      instruction: 'research a high-risk topic',
      requiredCapabilities: ['research'],
      risk: 'high',
      maxAssignments: 1,
    })
    assert.equal(result.plan.policyDecision, 'approval-required')
    assert.equal(result.dispatched.length, 0)
    assert.ok(result.approvalCode)
    assert.equal((await gateway.fleetStatus()).fleet.mailbox.queued, 0)
    assert.equal((await gateway.resolveApproval(result.approvalCode, 'approved'))?.status, 'approved')
    assert.equal((await gateway.fleetStatus()).fleet.mailbox.queued, 1)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})


test('compiled Workflow resumes its durable DAG after restart and completes the final stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-dag-recovery-'))
  let first
  let gateway
  try {
    first = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager' },
    })
    await first.stop()
    const workflow = await first.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const launch = await first.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
    )
    assert.equal(launch.dispatched.length, 1)
    await first.stop()

    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = {
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {
            setTimeout(() => {
              gateway.onSessionEvent(agent, {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: preset + '-result' }] } },
              })
              gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            }, 0)
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager' },
    })
    const sent = []
    const transport = {
      platform: 'feishu',
      async start() {},
      async stop() {},
      async send(destination, text) { sent.push({ destination, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()

    const deadline = Date.now() + 5_000
    let detail
    while (Date.now() < deadline) {
      detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      if (detail?.task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(detail?.task.status, 'completed')
    assert.ok(detail?.task.result?.includes('research: researcher-result'))
    assert.ok(detail?.task.result?.includes('write: writer-result'))
    const sendDeadline = Date.now() + 1_000
    while (!sent.some(item => item.text.includes('Workflow Research then write 完成')) && Date.now() < sendDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(sent.some(item => item.text.includes('Workflow Research then write 完成')))
    const status = await gateway.fleetStatus()
    assert.equal(status.fleet.mailbox.completed, 2)
  } finally {
    if (gateway) await gateway.stop()
    if (first) await first.stop()
    await rm(root, { recursive: true, force: true })
  }
})
