import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'

const owner = 'user:feishu:ou_hardening'
const target = {
  platform: 'feishu',
  chatId: 'oc_hardening',
  chatType: 'dm',
  userId: 'ou_hardening',
}

function config(stateDir) {
  return {
    stateDir,
    access: { userIds: ['ou_hardening'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      worker: {
        capabilities: ['analysis'],
        allowedUserIds: ['ou_hardening'],
      },
    },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      features: { savedWorkflows: true },
    },
  }
}

function workflow(nodes, entryNodeId, budget, inputs = []) {
  return {
    name: 'Workflow hardening test',
    description: 'Exercise launch invariants',
    ownerId: owner,
    scope: 'user',
    entryNodeId,
    inputs,
    outputs: [],
    nodes,
    edges: [],
    policy: {
      budget: {
        maxDepth: 4,
        maxParallel: budget.maxParallel,
        maxFanOut: budget.maxFanOut,
        maxMessages: 20,
        maxTokens: 20_000,
        maxCostUnits: 200,
      },
      allowedCapabilities: ['analysis'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
}

async function withGateway(run) {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-hardening-'))
  const gateway = new BotGateway({ get: () => undefined }, config(root))
  try {
    await gateway.start()
    await run(gateway)
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
}

test('initial workflow entry dispatch honors maxParallel', async () => {
  await withGateway(async gateway => {
    const definition = await gateway.createWorkflowDefinition(workflow([
      { id: 'root', label: 'Parallel entry', kind: 'parallel', children: ['first', 'second'] },
      { id: 'first', label: 'First task', kind: 'task', capability: 'analysis', outputs: ['result'] },
      { id: 'second', label: 'Second task', kind: 'task', capability: 'analysis', outputs: ['result'] },
    ], 'root', { maxParallel: 1, maxFanOut: 2 }), owner)
    const launch = await gateway.launchWorkflowDefinition(definition.id, owner, target, owner, { launchId: 'parallel-entry' })
    assert.equal(launch.dispatched.length, 1)
    const status = await gateway.fleetStatus()
    const nodeTasks = status.fleet.tasks.filter(task => task.workflowRunId === launch.workflowRunId && task.workflowNodeId !== '__root__')
    assert.equal(nodeTasks.length, 1)
  })
})

test('same workflow launchId creates one durable root and one delivery', async () => {
  await withGateway(async gateway => {
    const definition = await gateway.createWorkflowDefinition(workflow([
      { id: 'task', label: 'Single task', kind: 'task', capability: 'analysis', outputs: ['result'] },
    ], 'task', { maxParallel: 1, maxFanOut: 1 }), owner)
    const launches = await Promise.all([
      gateway.launchWorkflowDefinition(definition.id, owner, target, owner, { launchId: 'same-launch' }),
      gateway.launchWorkflowDefinition(definition.id, owner, target, owner, { launchId: 'same-launch' }),
    ])
    assert.equal(launches[0].workflowRunId, launches[1].workflowRunId)
    assert.equal(launches[0].rootTaskId, launches[1].rootTaskId)
    assert.equal(launches[0].dispatched.length, 1)
    assert.equal(launches[1].dispatched.length, 1)
    const status = await gateway.fleetStatus()
    const roots = status.fleet.tasks.filter(task => (
      task.workflowRunId === launches[0].workflowRunId && task.workflowNodeId === '__root__'
    ))
    assert.equal(roots.length, 1)
  })
})

test('workflow launch validates required and typed inputs before persistence', async () => {
  await withGateway(async gateway => {
    const definition = await gateway.createWorkflowDefinition(workflow([
      {
        id: 'task',
        label: 'Input task',
        kind: 'task',
        capability: 'analysis',
        inputs: [{ name: 'topic', source: { kind: 'input', name: 'topic' } }],
        outputs: ['result'],
      },
    ], 'task', { maxParallel: 1, maxFanOut: 1 }, [
      { name: 'topic', type: 'string', required: true },
    ]), owner)
    await assert.rejects(
      gateway.launchWorkflowDefinition(definition.id, owner, target, owner, { launchId: 'missing-input' }),
      /Workflow input topic is required/u,
    )
    await assert.rejects(
      gateway.launchWorkflowDefinition(definition.id, owner, target, owner, {
        launchId: 'wrong-type',
        inputs: { topic: 42 },
      }),
      /Workflow input topic must be of type string/u,
    )
    const valid = await gateway.launchWorkflowDefinition(definition.id, owner, target, owner, {
      launchId: 'valid-input',
      inputs: { topic: 'hello' },
    })
    assert.equal(valid.dispatched.length, 1)
  })
})
