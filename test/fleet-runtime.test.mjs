import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { createEnvelope } from '../dist/collaboration.js'
import {
  compileManagerDispatches,
  compileWorkflowLaunch,
  managerDescriptorsFromRoster,
  workflowDispatchKey,
} from '../dist/fleet-runtime.js'
import { generateManagerPlan } from '../dist/manager-policy.js'
import { emitMockAgentEvent, withMockSession } from './mock-agent.mjs'

const target = {
  platform: 'feishu',
  chatId: 'oc_manager',
  chatType: 'dm',
  userId: 'ou_user',
}

const runtimeFeatures = {
  managerAgent: true,
  savedWorkflows: true,
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

test('Gateway rejects Manager and Saved Workflow entrypoints while their feature flags are off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-runtime-feature-gates-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: { researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] } },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager' },
    })
    await assert.rejects(() => gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget: target,
      instruction: 'research this topic',
      requiredCapabilities: ['research'],
    }), /Manager Agent is disabled/u)
    await assert.rejects(
      () => gateway.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user'),
      /Saved Workflows are disabled/u,
    )
    assert.equal((await gateway.tasks.snapshot()).tasks.length, 0)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
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
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
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
    const launch = await gateway.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
      { inputs: { topic: 'research this topic' } },
    )
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
      collaboration: { enabled: true, approvalMode: 'auto-planned', managerBotId: 'manager', features: runtimeFeatures },
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

test('disabling Manager admission before approval prevents the delayed delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-disable-before-approval-'))
  let gateway
  const config = {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: { researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] } },
    collaboration: {
      enabled: true,
      approvalMode: 'auto-planned',
      managerBotId: 'manager',
      features: runtimeFeatures,
    },
  }
  try {
    gateway = new BotGateway({}, config)
    const result = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget: target,
      instruction: 'research a high-risk topic',
      requiredCapabilities: ['research'],
      risk: 'high',
      maxAssignments: 1,
    })
    assert.ok(result.approvalCode)
    await gateway.reconfigure({
      ...config,
      collaboration: {
        ...config.collaboration,
        features: { ...runtimeFeatures, managerAgent: false },
      },
    })
    assert.equal((await gateway.resolveApproval(result.approvalCode, 'approved'))?.status, 'approved')
    assert.equal((await gateway.tasks.task(result.taskId))?.status, 'failed')
    assert.equal((await gateway.fleetStatus()).fleet.mailbox.queued, 0)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})


test('compiled Workflow resumes its durable DAG after restart and completes the final stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-dag-recovery-'))
  let first
  let gateway
  const prompts = []
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
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
    })
    const workflow = await first.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const launch = await first.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
      { launchId: 'restart-dataflow', inputs: { topic: 'durable workflow recovery' } },
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
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup(prompt) {
            prompts.push({ preset, prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt) })
            setTimeout(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', {
                message: { content: [{ type: 'text', text: preset + '-result' }] },
              })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            }, 0)
          },
        })
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
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
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
    assert.ok(prompts.find(item => item.preset === 'researcher')?.prompt.includes('durable workflow recovery'))
    assert.ok(prompts.find(item => item.preset === 'writer')?.prompt.includes('researcher-result'))
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

test('Workflow launches are isolated by launchId and retain immutable revision history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-launch-isolation-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
    })
    const workflow = await gateway.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const first = await gateway.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
      { launchId: 'one', inputs: { topic: 'first launch' } },
    )
    const second = await gateway.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
      { launchId: 'two', inputs: { topic: 'second launch' } },
    )
    assert.notEqual(first.workflowRunId, second.workflowRunId)
    assert.notEqual(first.rootTaskId, second.rootTaskId)
    const current = await gateway.getWorkflowDefinition(workflow.id, 'user:feishu:ou_user')
    const updated = await gateway['workflows'].update(workflow.id, { description: 'revision two' }, 'user:feishu:ou_user', 1, 'test-revision-update')
    assert.equal(updated.revision, 2)
    const pinned = await gateway['workflows'].getRevision(workflow.id, 1, { actorId: 'user:feishu:ou_user' })
    assert.equal(pinned?.description, current?.description)
    const firstRoot = await gateway['tasks'].task(first.rootTaskId)
    assert.equal(firstRoot?.workflowRevision, 1)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Workflow recovery repairs a Task/Run created before Mailbox enqueue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-torn-enqueue-'))
  let first
  let gateway
  try {
    const config = {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
    }
    first = new BotGateway({}, config)
    const workflow = await first.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const workflowRunId = 'workflow-run:' + workflow.id + ':1:torn'
    const correlationId = 'workflow:' + workflow.id + ':1:torn'
    const rootTask = await first['tasks'].createTask({
      title: 'Workflow: ' + workflow.name,
      instruction: workflow.description ?? workflow.name,
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'workflow',
      workflowDefinitionId: workflow.id,
      workflowRevision: workflow.revision,
      workflowRunId,
      workflowNodeId: '__root__',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
      workflowInputs: { topic: 'repair me' },
    })
    const child = await first['tasks'].createTask({
      title: workflow.name + ': Research the topic',
      instruction: 'Research the topic',
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'researcher',
      acceptanceCriteria: ['result'],
      workflowDefinitionId: workflow.id,
      workflowRevision: workflow.revision,
      workflowRunId,
      workflowNodeId: 'research',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
      workflowInputs: { topic: 'repair me' },
    })
    await first['tasks'].createRun(child.id, 'researcher', 1)
    await first.stop()

    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          cancel() {},
          followup() {
            setTimeout(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', { message: { content: [{ type: 'text', text: preset + '-result' }] } })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            }, 0)
          },
        })
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, config)
    const sent = []
    const transport = { platform: 'feishu', async start() {}, async stop() {}, async send(destination, text) { sent.push({ destination, text }) } }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const deadline = Date.now() + 5_000
    let recovered
    while (Date.now() < deadline) {
      recovered = await gateway.fleetTaskDetail(rootTask.id, 'local-dashboard')
      if (
        recovered?.task.status === 'completed'
        && sent.some(item => item.text.includes('Workflow Research then write 完成'))
      ) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(recovered?.task.status, 'completed')
    assert.ok(sent.some(item => item.text.includes('Workflow Research then write 完成')))
  } finally {
    if (gateway) await gateway.stop()
    if (first) await first.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Workflow recovery keeps a delayed retry active instead of failing the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-delayed-retry-'))
  let first
  let gateway
  try {
    const config = {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: { researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] } },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
    }
    first = new BotGateway({}, config)
    const workflow = await first.createWorkflowDefinition({
      ...workflowDraft(),
      nodes: [workflowDraft().nodes[0]],
      edges: [],
      outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'research', output: 'result' } }],
    }, 'user:feishu:ou_user')
    const workflowRunId = 'workflow-run:' + workflow.id + ':1:retry'
    const correlationId = 'workflow:' + workflow.id + ':1:retry'
    const rootTask = await first['tasks'].createTask({
      title: 'Workflow: ' + workflow.name,
      instruction: workflow.name,
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'workflow',
      workflowDefinitionId: workflow.id,
      workflowRevision: 1,
      workflowRunId,
      workflowNodeId: '__root__',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
    })
    const child = await first['tasks'].createTask({
      title: workflow.name + ': Research',
      instruction: 'Research',
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'researcher',
      workflowDefinitionId: workflow.id,
      workflowRevision: 1,
      workflowRunId,
      workflowNodeId: 'research',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
    })
    const failedRun = await first['tasks'].createRun(child.id, 'researcher', 1)
    await first['tasks'].failRun(failedRun.id, 'temporary model error', false)
    const retryRun = await first['tasks'].createRun(child.id, 'researcher', 2, { parentRunId: failedRun.id })
    const retryEnvelope = createEnvelope({
      kind: 'request',
      from: 'service:workflow:' + workflow.id,
      to: 'researcher',
      taskId: child.id,
      runId: retryRun.id,
      attemptId: retryRun.attemptId,
      correlationId,
      payload: {
        workflowDefinitionId: workflow.id,
        workflowRevision: 1,
        workflowRunId,
        workflowRootTaskId: rootTask.id,
        workflowNodeId: 'research',
        instruction: 'Research',
        requester: 'user:feishu:ou_user',
        replyTarget: target,
      },
    })
    await first['mailbox'].enqueue(retryEnvelope, 'retry:test-delayed', Date.now() + 60_000)
    await first.stop()

    gateway = new BotGateway({ get: name => name === 'agents' ? { get() { return undefined } } : undefined }, config)
    await gateway.start()
    const rootAfterRecovery = await gateway['tasks'].task(rootTask.id)
    assert.equal(rootAfterRecovery?.status, 'pending')
    const childAfterRecovery = await gateway['tasks'].task(child.id)
    assert.equal(childAfterRecovery?.status, 'waiting')
  } finally {
    if (gateway) await gateway.stop()
    if (first) await first.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Workflow root failure cancels queued child work and fences its delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-cancel-children-'))
  let first
  let gateway
  try {
    const config = {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      access: { userIds: ['ou_user'] },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_user'] },
        writer: { capabilities: ['write'], allowedUserIds: ['ou_user'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', managerBotId: 'manager', features: runtimeFeatures },
    }
    first = new BotGateway({}, config)
    const workflow = await first.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_user')
    const workflowRunId = 'workflow-run:' + workflow.id + ':1:cancel'
    const correlationId = 'workflow:' + workflow.id + ':1:cancel'
    const rootTask = await first['tasks'].createTask({
      title: 'Workflow: ' + workflow.name,
      instruction: workflow.name,
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'workflow',
      workflowDefinitionId: workflow.id,
      workflowRevision: 1,
      workflowRunId,
      workflowNodeId: '__root__',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
    })
    const failedNode = await first['tasks'].createTask({
      title: 'Research',
      instruction: 'Research',
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'researcher',
      workflowDefinitionId: workflow.id,
      workflowRevision: 1,
      workflowRunId,
      workflowNodeId: 'research',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
    })
    await first['tasks'].failTask(failedNode.id, 'research failed', 'test')
    const child = await first['tasks'].createTask({
      title: 'Write',
      instruction: 'Write',
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'writer',
      workflowDefinitionId: workflow.id,
      workflowRevision: 1,
      workflowRunId,
      workflowNodeId: 'write',
      workflowReplyTarget: target,
      workflowTraceId: correlationId,
    })
    const childRun = await first['tasks'].createRun(child.id, 'writer', 1)
    const childEnvelope = createEnvelope({
      kind: 'request',
      from: 'service:workflow:' + workflow.id,
      to: 'writer',
      taskId: child.id,
      runId: childRun.id,
      attemptId: childRun.attemptId,
      correlationId,
      payload: {
        workflowDefinitionId: workflow.id,
        workflowRevision: 1,
        workflowRunId,
        workflowRootTaskId: rootTask.id,
        workflowNodeId: 'write',
        instruction: 'Write',
        requester: 'user:feishu:ou_user',
        replyTarget: target,
      },
    })
    const childKey = workflowDispatchKey(workflow.id, 1, 'write', workflowRunId)
    await first['mailbox'].enqueue(childEnvelope, childKey)
    await first.stop()

    gateway = new BotGateway({ get: name => name === 'agents' ? { get() { return undefined } } : undefined }, config)
    const transport = { platform: 'feishu', async start() {}, async stop() {}, async send() {} }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    assert.equal((await gateway['tasks'].task(rootTask.id))?.status, 'failed')
    assert.equal((await gateway['tasks'].task(child.id))?.status, 'cancelled')
    assert.equal((await gateway['mailbox'].getByIdempotencyKey(childKey))?.state, 'failed')
  } finally {
    if (gateway) await gateway.stop()
    if (first) await first.stop()
    await rm(root, { recursive: true, force: true })
  }
})


test('durable Workflow map fan-out dispatches bounded item Tasks and reduces their outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-map-runtime-'))
  let gateway
  const agents = new Map()
  const prompts = []
  try {
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          cancel() {},
          followup(prompt) {
            const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
            prompts.push({ preset, text })
            const response = preset === 'starter'
              ? '["one","two","three"]'
              : JSON.stringify({ result: preset + '-done', status: 'completed' })
            setTimeout(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', {
                message: { content: [{ type: 'text', text: response }] },
              })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            }, 0)
          },
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
      profiles: {
        starter: { capabilities: ['start'], allowedUserIds: ['ou_user'] },
        worker1: { capabilities: ['map'], allowedUserIds: ['ou_user'] },
        worker2: { capabilities: ['map'], allowedUserIds: ['ou_user'] },
        worker3: { capabilities: ['map'], allowedUserIds: ['ou_user'] },
      },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        features: { savedWorkflows: true },
        maxParallelRuns: 3,
      },
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

    const definition = await gateway.createWorkflowDefinition({
      name: 'Map and reduce',
      description: 'Expand a bounded list and collect the results',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        { id: 'start', label: 'Create list', kind: 'task', capability: 'start', outputs: ['result'] },
        {
          id: 'expand',
          label: 'Expand items',
          kind: 'map',
          map: {
            source: { kind: 'node-output', nodeId: 'start', output: 'result' },
            itemInput: 'item',
            templateNodeId: 'worker',
            maxFanOut: 3,
          },
        },
        { id: 'worker', label: 'Process item', kind: 'task', capability: 'map', outputs: ['result'] },
        {
          id: 'collect',
          label: 'Collect items',
          kind: 'reduce',
          reduce: {
            source: { kind: 'node-output', nodeId: 'expand', output: 'result' },
            reducer: 'concat',
          },
        },
      ],
      edges: [
        { from: 'start', to: 'expand' },
        { from: 'expand', to: 'collect' },
      ],
      policy: {
        budget: {
          maxDepth: 8,
          maxParallel: 3,
          maxFanOut: 3,
          maxMessages: 10,
          maxTokens: 20_000,
          maxCostUnits: 100,
        },
        allowedCapabilities: ['start', 'map'],
        allowedPermissions: [],
        allowExternalEffects: false,
      },
    }, 'user:feishu:ou_user')
    const launch = await gateway.launchWorkflowDefinition(
      definition.id,
      'user:feishu:ou_user',
      target,
      'user:feishu:ou_user',
      { launchId: 'map-runtime' },
    )
    assert.equal(launch.dispatched.length, 1)
    const deadline = Date.now() + 5_000
    let detail
    while (Date.now() < deadline) {
      detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      if (detail?.task.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(detail?.task.status, 'completed')
    const snapshot = await gateway.tasks.snapshot()
    const mapItems = snapshot.tasks.filter(task => (
      task.workflowRunId === launch.workflowRunId && task.workflowNodeId?.startsWith('map:expand:')
    ))
    assert.equal(mapItems.length, 3)
    assert.ok(mapItems.every(task => task.status === 'completed'))
    assert.ok(snapshot.tasks.some(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId === 'expand' && task.status === 'completed'))
    assert.ok(snapshot.tasks.some(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId === 'collect' && task.status === 'completed'))
    assert.ok(prompts.filter(item => item.preset.startsWith('worker')).length >= 3)
    assert.ok(sent.some(item => item.text.includes('Workflow Map and reduce 完成')))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
