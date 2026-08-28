import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { DshRuntimeAdapter } from '../dist/runtime-adapter.js'

test('Gateway exposes durable owner-scoped Workflow routines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-routine-gateway-'))
  const gateway = new BotGateway({}, {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
    collaboration: {
      features: {
        savedWorkflows: true,
        routines: true,
      },
    },
  })
  try {
    const routine = await gateway.createRoutine({
      name: 'weekday report',
      ownerId: 'user:feishu:ou_owner',
      workflowId: 'wf_report',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Singapore',
      inputs: { source: 'routine-test' },
      replyTarget: { platform: 'feishu', chatId: 'oc_owner', userId: 'ou_owner' },
    })
    assert.equal(routine.status, 'enabled')
    assert.equal((await gateway.listRoutines('user:feishu:ou_owner')).length, 1)
    assert.equal((await gateway.listRoutines('user:feishu:ou_other')).length, 0)
    const updated = await gateway.updateRoutine(
      routine.id,
      { enabled: false },
      'user:feishu:ou_owner',
    )
    assert.equal(updated.status, 'disabled')
    await assert.rejects(
      () => gateway.updateRoutine(routine.id, { enabled: true }, 'user:feishu:ou_other'),
      /does not belong/u,
    )
    assert.equal(await gateway.deleteRoutine(routine.id, 'user:feishu:ou_owner'), true)
    assert.equal((await gateway.listRoutines('user:feishu:ou_owner')).length, 0)
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('local DSH web dashboard creates a cron Bot dispatch without slash commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-web-cron-'))
  const gateway = new BotGateway({}, {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      analyst: { fleetRole: 'worker', capabilities: ['research'] },
    },
    collaboration: {
      features: {
        savedWorkflows: true,
        routines: true,
      },
    },
  })
  try {
    await gateway.start()
    const routine = await gateway.createWebDashboardRoutine({
      name: 'morning brief',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      to: 'analyst',
      instruction: 'write the morning brief',
    })
    assert.equal(routine.status, 'enabled')
    assert.equal(routine.workflowId, 'cron-bot:analyst')
    assert.equal(routine.inputs.to, 'analyst')
    assert.equal(routine.cron, '0 9 * * 1-5')
    const listed = await gateway.listRoutines()
    assert.equal(listed.some(item => item.id === routine.id), true)
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Gateway selects explicit Hermes/Grok profile runtimes and accepts host adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-runtime-gateway-'))
  const gateway = new BotGateway({}, {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      local: { runtimeAdapter: 'dsh' },
      remote: { runtimeAdapter: 'grok', model: 'grok-test' },
    },
    collaboration: {
      features: {
        externalRuntimes: true,
      },
    },
  })
  try {
    gateway.registerRuntimeAdapter(new DshRuntimeAdapter(async request => request.instruction))
    const runtimeProfiles = gateway.status().collaboration.runtimeProfiles
    assert.ok(runtimeProfiles.some(item => item.id === 'remote' && item.adapter === 'grok'))
    assert.ok(runtimeProfiles.some(item => item.id === 'local' && item.adapter === 'dsh'))
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('host runtime adapter registration stays disabled by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-runtime-disabled-'))
  const gateway = new BotGateway({}, {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
  })
  try {
    assert.throws(
      () => gateway.registerRuntimeAdapter(new DshRuntimeAdapter(async () => 'ok')),
      /External runtime adapters are disabled/u,
    )
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
