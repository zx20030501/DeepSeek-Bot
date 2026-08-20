import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BotDirectory,
  BotMailbox,
  FleetApprovalStore,
  FleetPlanner,
  GroupRoomStore,
  TaskRunStore,
  createEnvelope,
  parseBotMentions,
} from '../dist/collaboration.js'

test('parses only known bot mentions and keeps ordinary mentions as text', () => {
  const parsed = parseBotMentions(
    '@researcher 请研究 Hermes；@writer 写一个总结；@unknown 不要路由',
    ['researcher', 'writer'],
  )
  assert.deepEqual(parsed.botIds, ['researcher', 'writer'])
  assert.equal(parsed.instruction, '请研究 Hermes； 写一个总结；@unknown 不要路由')
})

test('BotDirectory exposes canonical sessions and capabilities', () => {
  const directory = new BotDirectory([
    { name: 'researcher', title: 'Researcher', capabilities: ['research', 'research'], skills: ['web'] },
    { name: 'disabled', enabled: false },
  ])
  const researcher = directory.get('RESEARCHER')
  assert.equal(researcher?.id, 'researcher')
  assert.deepEqual(researcher?.capabilities, ['research'])
  assert.match(researcher?.canonicalSessionId ?? '', /^hermes-bot-/u)
  assert.deepEqual(directory.ids(), ['researcher'])
})

test('BotDirectory isolates requester sessions and applies Bot-level ACLs', () => {
  const directory = new BotDirectory([
    { name: 'private', allowedUserIds: ['ou_a'], sessionScope: 'requester' },
    { name: 'shared', sessionScope: 'shared' },
  ])
  const targetA = { platform: 'feishu', chatId: 'oc_room', chatType: 'group', userId: 'ou_a' }
  const targetB = { ...targetA, userId: 'ou_b' }
  assert.equal(directory.canInvoke('private', targetA), true)
  assert.equal(directory.canInvoke('private', targetB), false)
  const a = directory.sessionIdFor('private', { requester: 'user:ou_a', target: targetA, taskId: 'task_1' })
  const b = directory.sessionIdFor('private', { requester: 'user:ou_b', target: targetB, taskId: 'task_2' })
  assert.notEqual(a, b)
  assert.equal(
    directory.sessionIdFor('shared', { requester: 'user:ou_a', target: targetA, taskId: 'task_1' }),
    directory.sessionIdFor('shared', { requester: 'user:ou_b', target: targetB, taskId: 'task_2' }),
  )
})

test('FleetPlanner selects authorized roles and exposes inspectable reasons', () => {
  const directory = new BotDirectory([
    { name: 'researcher', fleetRole: 'worker', capabilities: ['research', '检索'] },
    { name: 'reviewer', fleetRole: 'verifier', capabilities: ['review'] },
    { name: 'writer', fleetRole: 'synthesizer', capabilities: ['summary'] },
    { name: 'restricted', fleetRole: 'worker', capabilities: ['research'], allowedUserIds: ['ou_other'] },
  ])
  const plan = new FleetPlanner().plan('research and summary', directory, {
    platform: 'feishu', chatId: 'oc_room', userId: 'ou_me', chatType: 'group',
  })
  assert.deepEqual(plan.workerBotIds, ['researcher'])
  assert.equal(plan.verifierBotId, 'reviewer')
  assert.equal(plan.synthesizerBotId, 'writer')
  assert.ok(plan.reasons.researcher.includes('research'))
  assert.equal('restricted' in plan.reasons, false)
  const bounded = new FleetPlanner().plan('research and summary', directory, {
    platform: 'feishu', chatId: 'oc_room', userId: 'ou_me', chatType: 'group',
  }, 2)
  assert.ok(new Set([...bounded.workerBotIds, bounded.verifierBotId, bounded.synthesizerBotId].filter(Boolean)).size <= 2)
})

test('typed mailbox enforces lease fencing and persists terminal state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-mailbox-'))
  try {
    const mailbox = new BotMailbox(join(root, 'mailbox.jsonl'), { mailboxMaxAttempts: 2 })
    const envelope = createEnvelope({
      from: 'user:feishu:ou_user',
      to: 'researcher',
      taskId: 'task_1',
      runId: 'run_1',
      attemptId: 'attempt_1',
      correlationId: 'corr_1',
      epoch: 1,
      payload: { instruction: 'research' },
    })
    assert.equal(envelope.epoch, 1)
    const queued = await mailbox.enqueue(envelope, 'task_1:run_1')
    const lease = await mailbox.claim(['researcher'], 'worker-1')
    assert.ok(lease)
    assert.equal(lease?.item.state, 'claimed')
    assert.equal(await mailbox.complete({ ...lease, fencingToken: lease.fencingToken + 1 }), undefined)
    const acknowledged = await mailbox.acknowledge(lease)
    const running = await mailbox.start({ ...lease, item: acknowledged })
    assert.equal(running?.state, 'running')
    const completed = await mailbox.complete({ ...lease, item: running })
    assert.equal(completed?.state, 'completed')

    const cancelledEnvelope = createEnvelope({
      from: 'user', to: 'researcher', taskId: 'task_2', runId: 'run_2',
      attemptId: 'attempt_2', correlationId: 'corr_2', payload: {},
    })
    await mailbox.enqueue(cancelledEnvelope, 'task_2:run_2')
    const cancelledLease = await mailbox.claim(['researcher'], 'worker-2')
    assert.ok(cancelledLease)
    assert.equal((await mailbox.cancelRun('run_2', 'handoff'))?.state, 'failed')
    assert.equal(await mailbox.complete(cancelledLease), undefined)

    const reloaded = new BotMailbox(join(root, 'mailbox.jsonl'))
    assert.equal((await reloaded.get(queued.id))?.state, 'completed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox recovers expired leases, schedules exact wakeups, and dead-letters exhausted delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-mailbox-recovery-'))
  try {
    const base = Date.now()
    const mailbox = new BotMailbox(join(root, 'mailbox.jsonl'), {
      mailboxMaxAttempts: 2,
      mailboxLeaseMs: 5_000,
      mailboxRetryBaseMs: 50,
      mailboxRetryMaxMs: 50,
    })
    const delayed = createEnvelope({
      from: 'user', to: 'researcher', taskId: 'task_delayed', runId: 'run_delayed',
      attemptId: 'attempt_delayed', correlationId: 'corr_delayed', payload: {},
    })
    await mailbox.enqueue(delayed, 'delayed', base + 20_000)
    assert.equal(await mailbox.nextWakeAt(['researcher'], new Set(), base), base + 20_000)

    const envelope = createEnvelope({
      from: 'user', to: 'researcher', taskId: 'task_retry', runId: 'run_retry',
      attemptId: 'attempt_retry', correlationId: 'corr_retry', payload: {},
    })
    await mailbox.enqueue(envelope, 'retry', base)
    const firstClaimAt = Date.now() + 100
    const first = await mailbox.claim(['researcher'], 'worker-1', new Set(), firstClaimAt)
    assert.ok(first)
    assert.equal(await mailbox.complete(first, firstClaimAt + 5_001), undefined)
    const recovered = await mailbox.recoverExpired(firstClaimAt + 5_001)
    assert.equal(recovered[0]?.state, 'queued')
    const second = await mailbox.claim(['researcher'], 'worker-2', new Set(), firstClaimAt + 5_100)
    assert.ok(second)
    const exhausted = await mailbox.recoverExpired(firstClaimAt + 10_101)
    assert.equal(exhausted[0]?.state, 'dead-letter')
    assert.equal((await mailbox.get(envelope.id))?.state, 'dead-letter')
    const dashboard = await mailbox.dashboardSnapshot()
    assert.equal(dashboard.counts['dead-letter'], 1)
    assert.deepEqual(dashboard.deadLetters[0]?.envelope.payload, {})

    const restartAt = firstClaimAt + 11_000
    const restartEnvelope = createEnvelope({
      from: 'user', to: 'researcher', taskId: 'task_restart', runId: 'run_restart',
      attemptId: 'attempt_restart', correlationId: 'corr_restart', payload: {},
    })
    await mailbox.enqueue(restartEnvelope, 'restart', restartAt)
    const oldWorkerLease = await mailbox.claim(['researcher'], 'old-worker', new Set(), restartAt)
    assert.ok(oldWorkerLease)
    assert.equal((await mailbox.recoverForeignLeases('new-worker', restartAt + 1))[0]?.state, 'queued')
    assert.equal(await mailbox.complete(oldWorkerLease, restartAt + 2), undefined)
    assert.ok(await mailbox.claim(['researcher'], 'new-worker', new Set(), restartAt + 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox TTL expires queued work before it can reach a Bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-mailbox-ttl-'))
  try {
    const base = Date.now()
    const mailbox = new BotMailbox(join(root, 'mailbox.jsonl'))
    const envelope = createEnvelope({
      from: 'user', to: 'researcher', taskId: 'task_ttl', runId: 'run_ttl',
      attemptId: 'attempt_ttl', correlationId: 'corr_ttl', expiresAt: base + 100, payload: {},
    })
    await mailbox.enqueue(envelope, 'ttl', base)
    assert.equal((await mailbox.recoverExpired(base + 101))[0]?.lastError, 'message TTL expired')
    assert.equal(await mailbox.claim(['researcher'], 'worker', new Set(), base + 102), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Task/Run records and Group Room limits survive their state transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-collaboration-'))
  try {
    const tasks = new TaskRunStore(join(root, 'tasks.jsonl'))
    const task = await tasks.createTask({
      title: 'Research',
      instruction: 'Compare implementations',
      createdBy: 'user:feishu:ou_user',
      assignedTo: 'researcher',
    })
    const run = await tasks.createRun(task.id, 'researcher', 1)
    assert.equal((await tasks.startRun(run.id))?.status, 'running')
    assert.equal((await tasks.completeRun(run.id, 'done'))?.status, 'completed')
    assert.equal((await tasks.task(task.id))?.status, 'completed')

    const rooms = new GroupRoomStore(join(root, 'rooms.json'), { maxGroupTurns: 2, maxGroupMessages: 10 })
    const room = await rooms.open(
      { platform: 'feishu', chatId: 'oc_room', chatType: 'group' },
      task.id,
      ['researcher', 'writer'],
    )
    assert.equal((await tasks.attachRoom(task.id, room.id, 'captain'))?.roomId, room.id)
    await rooms.append(room.id, 'user:feishu:ou_user', '协作')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'researcher')
    await rooms.append(room.id, 'researcher', '研究结果')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'writer')
    await rooms.append(room.id, 'writer', '总结结果')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'researcher')
    await rooms.append(room.id, 'researcher', '第二轮研究')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'writer')
    await rooms.append(room.id, 'writer', '第二轮总结')
    assert.equal(await rooms.reserveNext(room.id), undefined)
    assert.equal((await rooms.get(room.id))?.roundCount, 2)
    assert.equal((await rooms.transcript(room.id)).length, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('six-Bot Group Room counts full rounds and fences superseded epochs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-room-rounds-'))
  try {
    const participants = ['a', 'b', 'c', 'd', 'e', 'f']
    const rooms = new GroupRoomStore(join(root, 'rooms.json'), { maxGroupRounds: 3, maxGroupMessages: 100 })
    const room = await rooms.open({ platform: 'feishu', chatId: 'oc_room' }, 'task_1', participants)
    const routed = []
    for (let index = 0; index < 18; index += 1) routed.push((await rooms.reserveNext(room.id))?.botId)
    assert.deepEqual(routed, [...participants, ...participants, ...participants])
    assert.equal((await rooms.get(room.id))?.roundCount, 3)
    assert.equal(await rooms.reserveNext(room.id), undefined)
    const nextEpoch = await rooms.supersede(room.id)
    assert.equal(nextEpoch?.epoch, 2)
    assert.equal(nextEpoch?.roundCount, 0)
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'a')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workflow, handoff, audit, and approval records persist across reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-fleet-state-'))
  try {
    const taskFile = join(root, 'tasks.jsonl')
    const tasks = new TaskRunStore(taskFile)
    const task = await tasks.createTask({ title: 'Fleet', instruction: 'investigate', createdBy: 'user', assignedTo: 'researcher' })
    const workflow = await tasks.createWorkflow({
      taskId: task.id,
      createdBy: 'user',
      instruction: 'investigate',
      replyTarget: { platform: 'feishu', chatId: 'oc_room', userId: 'ou_user' },
      workerBotIds: ['researcher'],
      verifierBotId: 'reviewer',
      synthesizerBotId: 'writer',
      status: 'pending-approval',
    })
    const run = await tasks.createRun(task.id, 'researcher', 1, { workflowId: workflow.id, phase: 'execute' })
    await tasks.recordWorkflowOutput(workflow.id, { runId: run.id, botId: 'researcher', phase: 'execute', text: 'evidence' })
    const handoff = await tasks.createHandoff(task.id, run.id, 'researcher', 'writer', 'write it', { platform: 'feishu', chatId: 'oc_room' })
    assert.equal((await tasks.updateHandoff(handoff.id, 'accepted', 'admin'))?.status, 'accepted')

    const approvalsFile = join(root, 'approvals.json')
    const approvals = new FleetApprovalStore(approvalsFile, 60_000)
    const approval = await approvals.create({ kind: 'workflow', requestedBy: 'user', summary: 'run fleet', entityId: workflow.id })
    assert.equal(await approvals.resolveByCode(approval.code, 'approved', 'another-user'), undefined)
    assert.equal((await approvals.resolveByCode(approval.code, 'approved', 'user'))?.status, 'approved')
    const expiring = await approvals.create({ kind: 'handoff', requestedBy: 'user', summary: 'expires', entityId: handoff.id })
    assert.equal((await approvals.resolveByCode(expiring.code, 'approved', 'another-user', expiring.expiresAt + 1))?.status, 'expired')
    const cancellable = await approvals.create({ kind: 'workflow', requestedBy: 'user', summary: 'cancel', entityId: workflow.id })
    assert.equal((await approvals.rejectEntity(workflow.id, 'local-dashboard')).find(item => item.id === cancellable.id)?.status, 'rejected')

    const reloadedTasks = new TaskRunStore(taskFile)
    assert.equal((await reloadedTasks.workflow(workflow.id))?.outputs[0]?.text, 'evidence')
    assert.equal((await reloadedTasks.workflowForTask(task.id))?.id, workflow.id)
    assert.equal((await reloadedTasks.handoff(handoff.id))?.toBot, 'writer')
    assert.equal((await reloadedTasks.snapshot()).handoffs[0]?.status, 'accepted')
    const reloadedApprovals = new FleetApprovalStore(approvalsFile)
    assert.equal((await reloadedApprovals.get(approval.id))?.status, 'approved')
    assert.equal((await reloadedApprovals.get(expiring.id))?.status, 'expired')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parallel workflow runs keep the parent Task running until the final sibling settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-parallel-task-'))
  try {
    const tasks = new TaskRunStore(join(root, 'tasks.jsonl'))
    const task = await tasks.createTask({ title: 'parallel', instruction: 'parallel', createdBy: 'user', assignedTo: 'a' })
    const workflow = await tasks.createWorkflow({
      taskId: task.id, createdBy: 'user', instruction: 'parallel', replyTarget: { platform: 'feishu', chatId: 'oc' },
      workerBotIds: ['a', 'b'], synthesizerBotId: 'a',
    })
    const first = await tasks.createRun(task.id, 'a', 1, { workflowId: workflow.id, phase: 'execute' })
    const second = await tasks.createRun(task.id, 'b', 1, { workflowId: workflow.id, phase: 'execute' })
    await tasks.startRun(first.id)
    await tasks.startRun(second.id)
    await tasks.completeRun(first.id, 'a-result', false)
    assert.equal((await tasks.task(task.id))?.status, 'running')
    await tasks.failRun(second.id, 'b-failed', false)
    assert.equal((await tasks.task(task.id))?.status, 'waiting')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent workflow updates retain every Run and output and reject invalid transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-lock-'))
  try {
    const tasks = new TaskRunStore(join(root, 'tasks.jsonl'))
    const task = await tasks.createTask({ title: 'concurrent', instruction: 'concurrent', createdBy: 'user', assignedTo: 'a' })
    const workflow = await tasks.createWorkflow({
      taskId: task.id,
      createdBy: 'user',
      instruction: 'concurrent',
      replyTarget: { platform: 'feishu', chatId: 'oc' },
      workerBotIds: ['a', 'b', 'c'],
      synthesizerBotId: 'a',
      status: 'pending-approval',
    })
    const runs = await Promise.all(['a', 'b', 'c'].map(botId => (
      tasks.createRun(task.id, botId, 1, { workflowId: workflow.id, phase: 'execute' })
    )))
    await Promise.all(runs.map(run => tasks.recordWorkflowOutput(workflow.id, {
      runId: run.id,
      botId: run.botId,
      phase: 'execute',
      text: `result-${run.botId}`,
    })))
    const current = await tasks.workflow(workflow.id)
    assert.equal(current?.runIds.length, 3)
    assert.equal(current?.outputs.length, 3)
    const dashboard = await tasks.dashboardSnapshot()
    assert.equal(dashboard.workflows[0]?.outputCount, 3)
    assert.equal('instruction' in dashboard.tasks[0], false)
    assert.equal('outputs' in dashboard.workflows[0], false)
    assert.equal(await tasks.transitionWorkflow(workflow.id, 'synthesizing', 'tester'), undefined)
    assert.equal((await tasks.transitionWorkflow(workflow.id, 'running', 'tester'))?.status, 'running')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
