import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CronExpressionError,
  RoutineScheduler,
  RoutineStore,
  nextCronOccurrence,
  parseCronExpression,
} from '../dist/routine.js'

const minute = value => Date.parse(value)

test('cron parser and matcher support five-field UTC schedules', () => {
  const parsed = parseCronExpression('*/5 * * * *')
  assert.deepEqual([...parsed.minute.values], [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  assert.equal(
    nextCronOccurrence(parsed, minute('2026-08-23T10:01:00.000Z')),
    minute('2026-08-23T10:05:00.000Z'),
  )
  assert.throws(
    () => parseCronExpression('* * * *'),
    error => error instanceof CronExpressionError,
  )
})

test('routine launch reservation survives a restart without duplicate IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-routine-'))
  try {
    const file = join(root, 'routines.jsonl')
    const createdAt = minute('2026-08-23T10:00:00.000Z')
    const store = new RoutineStore(file, 3, 1_000, 60_000, 30_000)
    const routine = await store.create({
      name: 'minute workflow',
      ownerId: 'user:test',
      workflowId: 'wf_daily',
      cron: '* * * * *',
      inputs: { source: 'timer' },
    }, createdAt)
    const scheduledAt = minute('2026-08-23T10:01:00.000Z')
    const [first] = await store.claimDue(scheduledAt)
    assert.equal(first.routineId, routine.id)
    assert.equal(first.attempt, 1)
    const duplicate = await store.claimDue(scheduledAt + 10_000)
    assert.deepEqual(duplicate, [])

    const reloaded = new RoutineStore(file, 3, 1_000, 60_000, 30_000)
    const recovered = await reloaded.claimDue(scheduledAt + 30_001)
    assert.equal(recovered[0].id, first.id)
    assert.equal(recovered[0].attempt, 1)

    await reloaded.recordLaunchResult(routine.id, first.id, {
      status: 'started',
      runId: 'run_1',
    }, scheduledAt + 31_000)
    const next = await reloaded.claimDue(scheduledAt + 60_000)
    assert.notEqual(next[0].id, first.id)
    assert.equal(next[0].attempt, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('routine launch failures retry with the same durable launch ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-routine-retry-'))
  try {
    const file = join(root, 'routines.jsonl')
    const at = minute('2026-08-23T11:00:00.000Z')
    const store = new RoutineStore(file, 2, 1_000, 60_000, 30_000)
    const routine = await store.create({
      name: 'retry workflow',
      ownerId: 'user:test',
      workflowId: 'wf_retry',
      cron: '* * * * *',
    }, at)
    const launch = (await store.claimDue(at + 60_000))[0]
    await store.recordLaunchResult(routine.id, launch.id, {
      status: 'failed',
      error: 'temporary',
      retryable: true,
    }, at + 60_000)
    assert.deepEqual(await store.claimDue(at + 60_500), [])
    const retry = (await store.claimDue(at + 61_001))[0]
    assert.equal(retry.id, launch.id)
    assert.equal(retry.attempt, 2)
    await store.recordLaunchResult(routine.id, retry.id, {
      status: 'failed',
      error: 'permanent',
      retryable: false,
    }, at + 62_000)
    const record = await store.get(routine.id)
    assert.equal(record.lastRunStatus, 'failed')
    assert.equal(record.pendingLaunch, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scheduler creates only structured Workflow launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-routine-scheduler-'))
  try {
    const file = join(root, 'routines.jsonl')
    const at = minute('2026-08-23T12:00:00.000Z')
    const store = new RoutineStore(file)
    await store.create({
      name: 'scheduled workflow',
      ownerId: 'user:test',
      workflowId: 'wf_scheduled',
      cron: '* * * * *',
    }, at - 60_000)
    const launches = []
    const scheduler = new RoutineScheduler({
      store,
      now: () => at,
      pollMs: 250,
      launch: async launch => {
        launches.push(launch)
        return { status: 'started', runId: 'run_scheduled' }
      },
    })
    scheduler.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    await scheduler.stop()
    assert.equal(launches.length, 1)
    assert.equal(launches[0].workflowId, 'wf_scheduled')
    assert.equal(launches[0].inputs.constructor, Object)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
