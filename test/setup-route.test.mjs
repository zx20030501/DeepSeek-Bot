import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { installSetupRoute } from '../dist/setup-route.js'

function createHarness(actions) {
  let handler
  const settings = {
    writable: true,
    get() { return {} },
    async replace() {},
  }
  const credentials = {
    async describe() { return { configured: true, writable: true, source: 'test' } },
  }
  const ctx = {
    get(name) { return name === 'settings' ? settings : name === 'credentials' ? credentials : undefined },
    inject(_services, callback) {
      callback({
        logger: { error() {} },
        webServer: { register(route) { handler = route.handler; return () => {} } },
        effect(effect) { effect(); return () => {} },
      })
    },
  }
  const source = () => ({
    enabled: true,
    feishu: { enabled: true, appId: 'cli_test', domain: 'feishu', requireMention: true },
    access: { userIds: ['ou_test'], chatIds: [], pairing: true },
    collaboration: {
      enabled: true, autoPlanner: true, approvalMode: 'auto-planned', defaultSessionScope: 'requester',
      maxGroupBots: 6, maxGroupRounds: 3, maxGroupMessages: 10, maxParallelRuns: 6, botRunMaxAttempts: 3,
    },
    profiles: [],
  })
  installSetupRoute(ctx, source, () => ({ fleet: { tasks: [] } }), actions)
  return {
    async post(body, remoteAddress = '127.0.0.1') {
      const raw = JSON.stringify(body)
      const req = Readable.from([Buffer.from(raw)])
      req.method = 'POST'
      req.headers = {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(raw)),
      }
      req.socket = { remoteAddress }
      return new Promise(resolve => {
        const response = { status: 0, headers: {}, body: '' }
        const res = {
          writeHead(status, headers = {}) { response.status = status; response.headers = headers },
          end(chunk = '') {
            response.body += String(chunk)
            resolve({ ...response, json: response.body ? JSON.parse(response.body) : undefined })
          },
        }
        handler(req, res)
      })
    },
  }
}

test('trusted setup route exposes on-demand detail and task controls without a credential body', async () => {
  const calls = []
  const harness = createHarness({
    async fleetTaskDetail(taskId) {
      calls.push(['detail', taskId])
      return {
        task: { id: taskId, title: 'x', instruction: 'body', createdBy: 'user', assignedTo: 'bot', acceptanceCriteria: [], priority: 50, status: 'failed', createdAt: 1, updatedAt: 2 },
        runs: [], handoffs: [], audits: [], deliveries: [],
      }
    },
    async cancelFleetTask(taskId) {
      calls.push(['cancel', taskId])
      return { id: taskId, title: 'x', instruction: 'body', createdBy: 'user', assignedTo: 'bot', acceptanceCriteria: [], priority: 50, status: 'cancelled', createdAt: 1, updatedAt: 2 }
    },
    async replayFleetTask(taskId) {
      calls.push(['replay', taskId])
      return { sourceTaskId: taskId, taskId: 'task_new', status: 'started' }
    },
  })

  const detail = await harness.post({ action: 'fleet_task_detail', taskId: 'task_old' })
  assert.equal(detail.status, 200)
  assert.equal(detail.json.taskDetail.task.instruction, 'body')
  assert.equal('appSecret' in detail.json, false)

  const cancel = await harness.post({ action: 'fleet_task_cancel', taskId: 'task_old' })
  assert.equal(cancel.status, 200)
  assert.match(cancel.json.message, /已取消任务/u)

  const replay = await harness.post({ action: 'fleet_task_replay', taskId: 'task_old' })
  assert.equal(replay.status, 200)
  assert.equal(replay.json.replay.taskId, 'task_new')
  assert.deepEqual(calls, [['detail', 'task_old'], ['cancel', 'task_old'], ['replay', 'task_old']])
})

test('remote callers cannot invoke Fleet task controls', async () => {
  let called = false
  const harness = createHarness({
    async cancelFleetTask() { called = true; return undefined },
  })
  const response = await harness.post({ action: 'fleet_task_cancel', taskId: 'task_old' }, '10.0.0.2')
  assert.equal(response.status, 403)
  assert.equal(called, false)
})
