import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { ManagerActionLog, ManagerPauseRegistry } from '../dist/manager-control.js'
import { withMockSession } from './mock-agent.mjs'

const replyTarget = { platform: 'feishu', chatId: 'oc_manager', chatType: 'dm', userId: 'ou_user' }

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for condition')
}

async function makeGateway(root, profiles) {
  const agents = new Map()
  const created = []
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
      created.push({ preset: meta?.agentPreset ?? 'unknown', agent })
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
      managerBotId: 'manager',
      features: { managerAgent: true, peerMessaging: true },
    },
  })
  gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
  gateway.transportByPlatform.set('feishu', gateway.transports[0])
  await gateway.start()
  return { gateway, created }
}

const twoWorkers = {
  'worker-a': { title: 'Alpha worker', capabilities: ['alpha'] },
  'worker-b': { title: 'Beta worker', capabilities: ['beta'] },
}

test('managerObserve derives available/busy/timeout/unavailable from real run state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-observe-'))
  let gateway
  try {
    const setup = await makeGateway(root, twoWorkers)
    gateway = setup.gateway

    let observation = await gateway.managerObserve()
    const byId = id => observation.bots.find(bot => bot.id === id)
    assert.equal(byId('worker-a').status, 'available')
    assert.equal(byId('worker-b').status, 'available')

    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget,
      instruction: 'Run the alpha analysis',
      requiredCapabilities: ['alpha'],
      maxAssignments: 1,
    })
    assert.equal(planned.dispatched.length, 1)
    assert.equal(planned.dispatched[0].to, 'worker-a')
    await waitUntil(async () => {
      observation = await gateway.managerObserve()
      return observation.bots.find(bot => bot.id === 'worker-a')?.status === 'busy'
    })
    assert.equal(byId('worker-a').status, 'busy')

    const run = observation.runs.find(item => item.botId === 'worker-a' && (item.status === 'queued' || item.status === 'running'))
    assert.ok(run)
    await gateway.tasks.failRun(run.id, 'run timed out after lease expiry', true)
    await waitUntil(async () => {
      observation = await gateway.managerObserve()
      return observation.bots.find(bot => bot.id === 'worker-a')?.status === 'timeout'
    })
    assert.equal(byId('worker-a').status, 'timeout')
    assert.match(byId('worker-a').lastFailure.error, /timed out/u)

    await gateway.managerPause('worker-b', { reason: 'maintenance window', actor: 'manager' })
    observation = await gateway.managerObserve()
    assert.equal(byId('worker-b').status, 'unavailable')
    assert.equal(byId('worker-b').paused.reason, 'maintenance window')

    assert.equal(await gateway.managerResume('worker-b', 'manager'), true)
    observation = await gateway.managerObserve()
    assert.equal(byId('worker-b').status, 'available')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a paused Bot is excluded from Manager planning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-pause-'))
  let gateway
  try {
    const setup = await makeGateway(root, twoWorkers)
    gateway = setup.gateway
    await gateway.managerPause('worker-a', { reason: 'out of rotation', actor: 'manager' })

    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget,
      instruction: 'Alpha only work',
      requiredCapabilities: ['alpha'],
      maxAssignments: 1,
    })
    assert.equal(planned.dispatched.length, 0)
    assert.equal(planned.plan.policyDecision, 'deny')
    const detail = await gateway.fleetTaskDetail(planned.taskId, 'local-dashboard')
    assert.equal(detail.task.status, 'failed')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('managerWait returns the terminal state and honours the caller timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-wait-'))
  let gateway
  try {
    const setup = await makeGateway(root, twoWorkers)
    gateway = setup.gateway
    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget,
      instruction: 'Long running alpha',
      requiredCapabilities: ['alpha'],
      maxAssignments: 1,
    })
    const timedOut = await gateway.managerWait(planned.taskId, { timeoutMs: 100, pollMs: 20 })
    assert.equal(timedOut.timedOut, true)
    assert.notEqual(timedOut.status, 'completed')

    await gateway.tasks.completeTask(planned.taskId, 'alpha finished', 'test')
    const result = await gateway.managerWait(planned.taskId, { timeoutMs: 2_000 })
    assert.equal(result.status, 'completed')
    assert.equal(result.result, 'alpha finished')
    assert.equal(result.timedOut, false)

    const history = await gateway.managerHistory({ taskId: planned.taskId, kind: 'wait' })
    assert.ok(history.some(action => action.detail?.status === 'completed'))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('managerStop cancels the task, its runs, and records a durable action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-stop-'))
  let gateway
  try {
    const setup = await makeGateway(root, twoWorkers)
    gateway = setup.gateway
    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget,
      instruction: 'Do the alpha work',
      requiredCapabilities: ['alpha'],
      maxAssignments: 1,
    })
    await waitUntil(async () => {
      const detail = await gateway.fleetTaskDetail(planned.taskId, 'local-dashboard')
      return detail.runs.some(run => run.status === 'running')
    })
    const stopped = await gateway.managerStop(planned.taskId, { reason: 'direction changed', actor: 'manager' })
    assert.equal(stopped.cancelled, true)
    assert.equal(stopped.status, 'cancelled')
    const snapshot = await gateway.tasks.snapshot()
    const task = snapshot.tasks.find(item => item.id === planned.taskId)
    assert.equal(task.status, 'cancelled')
    assert.ok(snapshot.runs.filter(run => run.taskId === planned.taskId).every(run => run.status === 'cancelled'))
    const history = await gateway.managerHistory({ taskId: planned.taskId })
    assert.ok(history.some(action => action.kind === 'plan'))
    assert.ok(history.some(action => action.kind === 'dispatch'))
    assert.ok(history.some(action => action.kind === 'stop'))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('managerReplan auto-dispatches replacement delegations after a worker times out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-replan-'))
  let gateway
  try {
    const setup = await makeGateway(root, {
      'worker-a': { title: 'Alpha worker', capabilities: ['alpha'] },
      'worker-b': { title: 'Alpha fallback', capabilities: ['alpha'] },
    })
    gateway = setup.gateway
    const planned = await gateway.planManagerTask({
      requester: 'user:feishu:ou_user',
      replyTarget,
      instruction: 'Analyze the alpha dataset',
      requiredCapabilities: ['alpha'],
      maxAssignments: 1,
    })
    assert.equal(planned.dispatched.length, 1)
    assert.equal(planned.dispatched[0].to, 'worker-a')
    const runId = planned.dispatched[0].runId
    await gateway.tasks.failRun(runId, 'run timed out after lease expiry', false)

    const replanned = await gateway.managerReplan({
      taskId: planned.taskId,
      observations: [{ botId: 'worker-a', status: 'timeout', reason: 'lease expired' }],
      actor: 'manager',
      auto: true,
    })
    assert.equal(replanned.autoDispatched, true)
    assert.ok(replanned.dispatchedTaskId)
    assert.equal(replanned.dispatchedEnvelopes.length, 1)
    assert.equal(replanned.dispatchedEnvelopes[0].to, 'worker-b')
    assert.equal(replanned.traceId, planned.traceId)
    assert.ok(replanned.suggestion.replacementDelegations.some(intent => intent.toBot === 'worker-b'))

    const history = await gateway.managerHistory({ taskId: planned.taskId, kind: 'replan' })
    assert.equal(history.length, 1)
    const observation = await gateway.managerObserve()
    assert.equal(observation.bots.find(bot => bot.id === 'worker-a').status, 'timeout')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('ManagerActionLog and ManagerPauseRegistry are durable across reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-manager-durable-'))
  const actionsFile = join(root, 'manager-actions.jsonl')
  const pausesFile = join(root, 'manager-pauses.jsonl')
  try {
    const log = new ManagerActionLog(actionsFile)
    await log.record({ kind: 'plan', actor: 'user:feishu:ou_user', taskId: 'task-1', traceId: 'trace-1', detail: { planId: 'plan-1' } })
    await log.record({ kind: 'dispatch', actor: 'manager', taskId: 'task-1', traceId: 'trace-1', detail: { dispatched: 2 } })
    await log.record({ kind: 'stop', actor: 'manager', taskId: 'task-1', detail: { reason: 'x' } })
    const pauses = new ManagerPauseRegistry(pausesFile)
    await pauses.pause({ botId: 'worker-a', reason: 'maintenance', actor: 'manager' })

    const reloadedLog = new ManagerActionLog(actionsFile)
    const reloadedPauses = new ManagerPauseRegistry(pausesFile)
    const actions = await reloadedLog.query({ taskId: 'task-1' })
    assert.deepEqual(actions.map(action => action.kind), ['stop', 'dispatch', 'plan'])
    assert.equal((await reloadedLog.last('task-1', 'plan')).detail.planId, 'plan-1')
    assert.equal(await reloadedPauses.isPaused('worker-a'), true)

    await reloadedPauses.pause({ botId: 'worker-b', reason: 'short outage', actor: 'manager', durationMs: 1_000 })
    await reloadedPauses.sweep(Date.now() + 5_000)
    assert.equal(await reloadedPauses.isPaused('worker-b'), false)
    assert.equal(await reloadedPauses.isPaused('worker-a'), true)
    assert.equal(await reloadedPauses.resume('worker-a', 'manager') !== undefined, true)
    assert.equal(await reloadedPauses.isPaused('worker-a'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
