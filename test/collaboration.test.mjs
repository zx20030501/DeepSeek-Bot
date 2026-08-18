import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BotDirectory,
  BotMailbox,
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

    const reloaded = new BotMailbox(join(root, 'mailbox.jsonl'))
    assert.equal((await reloaded.get(queued.id))?.state, 'completed')
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

    const rooms = new GroupRoomStore(join(root, 'rooms.json'), { maxGroupTurns: 2, maxGroupMessages: 4 })
    const room = await rooms.open(
      { platform: 'feishu', chatId: 'oc_room', chatType: 'group' },
      task.id,
      ['researcher', 'writer'],
    )
    await rooms.append(room.id, 'user:feishu:ou_user', '协作')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'researcher')
    await rooms.append(room.id, 'researcher', '研究结果')
    assert.equal((await rooms.reserveNext(room.id))?.botId, 'writer')
    await rooms.append(room.id, 'writer', '总结结果')
    assert.equal(await rooms.reserveNext(room.id), undefined)
    assert.equal((await rooms.transcript(room.id)).length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
