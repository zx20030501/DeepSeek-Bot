import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { emitMockAgentEvent, withMockSession } from './mock-agent.mjs'

const target = { platform: 'feishu', chatId: 'oc_wf', chatType: 'dm', userId: 'ou_user' }

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

/**
 * Mock agent registry. `behaviours[preset]` receives (attempt, respond):
 * respond('ok', text) completes the turn; respond('error') fails it; an
 * undefined behaviour leaves the run active without completing.
 */
function makeRegistry(behaviours = {}) {
  const agents = new Map()
  const attempts = new Map()
  const calls = new Map()
  let gatewayRef = () => { throw new Error('gateway not attached') }
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
          const attempt = (attempts.get(String(sessionId)) ?? 0) + 1
          attempts.set(String(sessionId), attempt)
          const total = (calls.get(preset) ?? 0) + 1
          calls.set(preset, total)
          const behaviour = behaviours[preset]
          if (behaviour === undefined) return
          behaviour(total, (kind, payload) => {
            if (kind === 'error') {
              emitMockAgentEvent(gatewayRef(), agent, 'turn/end', { reason: { kind: 'error' } })
              return
            }
            emitMockAgentEvent(gatewayRef(), agent, 'assistant/message', { message: { content: [{ type: 'text', text: payload }] } })
            emitMockAgentEvent(gatewayRef(), agent, 'turn/end', { reason: { kind: 'completed' } })
          })
        },
      })
      agents.set(String(sessionId), agent)
      return { agent }
    },
  }
  return {
    registry,
    attach(gateway) { gatewayRef = () => gateway },
    calls,
  }
}

async function makeGateway(root, behaviours = {}) {
  const kit = makeRegistry(behaviours)
  const gateway = new BotGateway({ get: name => name === 'agents' ? kit.registry : undefined }, {
    stateDir: root,
    access: { userIds: ['ou_user'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      starter: { capabilities: ['start'] },
      worker: { capabilities: ['work'] },
    },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      features: { savedWorkflows: true, peerMessaging: true },
    },
  })
  gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
  gateway.transportByPlatform.set('feishu', gateway.transports[0])
  await gateway.start()
  kit.attach(gateway)
  return { gateway, kit }
}

function node(id, kind, extra = {}) {
  return { id, label: id, kind, outputs: ['result'], ...extra }
}

function policy(allowedCapabilities) {
  return {
    budget: { maxDepth: 8, maxParallel: 4, maxFanOut: 4, maxMessages: 20, maxTokens: 20_000, maxCostUnits: 100 },
    allowedCapabilities,
    allowedPermissions: [],
    allowExternalEffects: false,
  }
}

async function saveAndLaunch(gateway, name, definition) {
  const created = await gateway.createWorkflowDefinition(definition, 'user:feishu:ou_user')
  return gateway.launchWorkflowDefinition(created.id, 'user:feishu:ou_user', target, 'user:feishu:ou_user', { launchId: name + ':' + Date.now() })
}

test('approval node gates the workflow until approved, then continues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-approval-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["ready"]'),
      worker: (attempt, respond) => respond('ok', 'finish-result'),
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'approval-run', {
      name: 'Approved flow',
      description: 'gated by approval',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('gate', 'approval', { approval: { risk: 'high', requestedBy: 'policy', reason: 'high-risk stage' } }),
        node('finish', 'task', { capability: 'work' }),
      ],
      edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'finish' }],
      policy: policy(['start', 'work']),
    })

    await waitUntil(async () => {
      const approvals = await gateway.approvals.snapshot()
      return approvals.some(approval => approval.kind === 'workflow' && approval.entityId.startsWith('compiled-workflow:') && approval.status === 'pending')
    })
    let detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.notEqual(detail.task.status, 'completed')
    assert.notEqual(detail.task.status, 'failed')

    const approvals = await gateway.approvals.snapshot()
    const gate = approvals.find(approval => approval.kind === 'workflow' && approval.entityId.includes('|gate'))
    assert.ok(gate)
    await gateway.resolveApproval(gate.code, 'approved')

    await waitUntil(async () => {
      detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'completed'
    })
    assert.equal(detail.task.status, 'completed')
    const snapshot = await gateway.tasks.snapshot()
    const gateTask = snapshot.tasks.find(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId === 'gate')
    assert.equal(gateTask.status, 'completed')
    assert.match(gateTask.result, /"approved":true/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a rejected approval node fails the workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-approval-reject-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["ready"]'),
      worker: (attempt, respond) => respond('ok', 'never'),
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'reject-run', {
      name: 'Rejected flow',
      description: 'gated by approval',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('gate', 'approval', { approval: { risk: 'high', requestedBy: 'policy', reason: 'must be rejected' } }),
        node('finish', 'task', { capability: 'work' }),
      ],
      edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'finish' }],
      policy: policy(['start', 'work']),
    })
    await waitUntil(async () => {
      const approvals = await gateway.approvals.snapshot()
      return approvals.some(approval => approval.kind === 'workflow' && approval.entityId.startsWith('compiled-workflow:'))
    })
    const approvals = await gateway.approvals.snapshot()
    const gate = approvals.find(approval => approval.kind === 'workflow' && approval.entityId.includes('|gate'))
    assert.ok(gate)
    await gateway.resolveApproval(gate.code, 'rejected')
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'failed'
    })
    const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.match(detail.task.error, /审批/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('retry node re-dispatches a failed node up to maxAttempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-retry-'))
  let gateway
  try {
    const calls = { worker: 0 }
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["go"]'),
      worker: (total, respond) => {
        calls.worker = total
        if (total <= 1) respond('error')
        else respond('ok', 'recovered-on-retry')
      },
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'retry-run', {
      name: 'Retry flow',
      description: 'retries once',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('flaky', 'task', { capability: 'work', retry: { maxAttempts: 2, backoffMs: 0 } }),
      ],
      edges: [{ from: 'start', to: 'flaky' }],
      policy: policy(['start', 'work']),
    })
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'completed'
    })
    const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.equal(detail.task.status, 'completed')
    assert.match(detail.task.result, /recovered-on-retry/u)
    const snapshot = await gateway.tasks.snapshot()
    const flakyTasks = snapshot.tasks.filter(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId === 'flaky')
    assert.equal(flakyTasks.length, 1)
    const runCount = snapshot.runs.filter(run => flakyTasks.some(task => task.id === run.taskId)).length
    assert.ok(runCount >= 2, 'expected at least two runs for the retried node')
    assert.equal(calls.worker, 2)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

function definitionEntityId(snapshot) {
  const task = snapshot.tasks.find(item => item.workflowNodeId !== undefined)
  return task?.workflowDefinitionId
}

test('retry exhaustion fails the workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-retry-exhaust-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["go"]'),
      worker: (total, respond) => respond('error'),
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'retry-exhaust', {
      name: 'Exhausted retry',
      description: 'always fails',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('flaky', 'task', { capability: 'work', retry: { maxAttempts: 2, backoffMs: 0 } }),
      ],
      edges: [{ from: 'start', to: 'flaky' }],
      policy: policy(['start', 'work']),
    })
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'failed'
    })
    const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.match(detail.task.error, /exhausted/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('timeout node fails a hung node after its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-timeout-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["go"]'),
      // worker has no behaviour: its run hangs until the timeout wake.
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'timeout-run', {
      name: 'Timeout flow',
      description: 'node hangs',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('hung', 'task', { capability: 'work', timeout: { timeoutMs: 1_000 } }),
      ],
      edges: [{ from: 'start', to: 'hung' }],
      policy: policy(['start', 'work']),
    })
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'failed'
    }, 5_000)
    const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.match(detail.task.error, /timed out/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('sequential container passes through after its children complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-wf-container-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      starter: (attempt, respond) => respond('ok', '["go"]'),
      worker: (total, respond) => respond('ok', 'done'),
    })
    gateway = setup.gateway
    const launch = await saveAndLaunch(gateway, 'container-run', {
      name: 'Container flow',
      description: 'sequential scope',
      ownerId: 'user:feishu:ou_user',
      scope: 'user',
      entryNodeId: 'start',
      inputs: [],
      outputs: [],
      nodes: [
        node('start', 'task', { capability: 'start' }),
        node('seq', 'sequential', { children: ['a', 'b'] }),
        node('a', 'task', { capability: 'work' }),
        node('b', 'task', { capability: 'work' }),
        node('finish', 'task', { capability: 'work' }),
      ],
      edges: [
        { from: 'start', to: 'seq' },
        { from: 'seq', to: 'finish' },
      ],
      policy: policy(['start', 'work']),
    })
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
      return detail.task.status === 'completed'
    })
    const detail = await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard')
    assert.equal(detail.task.status, 'completed')
    const snapshot = await gateway.tasks.snapshot()
    const seq = snapshot.tasks.find(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId === 'seq')
    assert.equal(seq.status, 'completed')
    assert.match(seq.result, /"expanded":true/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
