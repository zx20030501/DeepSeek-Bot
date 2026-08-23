import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { installSetupRoute } from '../dist/setup-route.js'

function createHarness(actions) {
  let handler
  const directReplaceCalls = []
  const settings = {
    writable: true,
    get() { return {} },
    async replace(namespace, value) { directReplaceCalls.push([namespace, value]) },
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
      features: {
        dynamicRegistry: true,
        chatBotCreation: true,
        peerMessaging: true,
        managerAgent: true,
        savedWorkflows: true,
        externalRuntimes: false,
      },
    },
    profiles: [],
  })
  installSetupRoute(ctx, source, () => ({ fleet: { tasks: [] } }), actions)
  return {
    settings: source(),
    directReplaceCalls,
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

test('trusted setup route manages dynamic Bot lifecycle while remote callers remain blocked', async () => {
  const calls = []
  const harness = createHarness({
    async setDynamicBotStatus(botId, status) {
      calls.push([botId, status])
      return {
        definition: {
          id: botId, handle: 'analyst', scope: 'user', ownerId: 'user:feishu:ou_test', source: 'chat',
          status, version: 2, currentRevision: 1, createdAt: 1, updatedAt: 2,
        },
        revision: {
          id: 'revision-1', botId, revision: 1, title: 'Analyst', capabilities: [], skills: [],
          fleetRole: 'worker', sessionScope: 'requester', allowedUserIds: ['ou_test'], allowedChatIds: [],
          approvalRequired: false, createdBy: 'user:feishu:ou_test', createdAt: 1,
        },
      }
    },
  })
  const disabled = await harness.post({ action: 'bot_registry_status', botId: 'bot-1', status: 'disabled' })
  assert.equal(disabled.status, 200)
  assert.match(disabled.json.message, /已停用 @analyst/u)
  const blocked = await harness.post({ action: 'bot_registry_status', botId: 'bot-1', status: 'deleted' }, '10.0.0.2')
  assert.equal(blocked.status, 403)
  assert.deepEqual(calls, [['bot-1', 'disabled']])
})

test('setup save rejects a static Bot handle reserved by a dynamic definition or tombstone', async () => {
  let validated
  const harness = createHarness({
    async validateStaticProfiles(handles) {
      validated = handles
      throw new Error('Bot ID @analyst 已被动态 Bot 或其删除墓碑永久占用')
    },
  })
  const response = await harness.post({
    action: 'save',
    settings: { ...harness.settings, profiles: [{
      id: 'analyst', title: 'Static Analyst', description: '', provider: '', model: '', maxTokens: 8192,
      enabled: true, capabilities: [], skills: [], soul: '', fleetRole: 'generalist', sessionScope: 'requester',
      allowedUserIds: [], allowedChatIds: [], approvalRequired: false,
    }] },
  })
  assert.equal(response.status, 409)
  assert.match(response.json.error, /墓碑|占用/u)
  assert.deepEqual(validated, ['analyst'])
})

test('setup save waits for transactional runtime apply and does not fall back to direct persistence on failure', async () => {
  let releaseApply
  const applyReleased = new Promise(resolve => { releaseApply = resolve })
  let applyReached
  const reachedApply = new Promise(resolve => { applyReached = resolve })
  let received
  const harness = createHarness({
    async saveAndApplySettings(settings, appSecret) {
      received = { settings, appSecret }
      applyReached()
      await applyReleased
      throw new Error(`controlled runtime apply failure containing ${appSecret}`)
    },
  })
  const pendingResponse = harness.post({
    action: 'save',
    appSecret: 'new-secret-for-test',
    settings: harness.settings,
  })
  await reachedApply
  const stateBeforeRelease = await Promise.race([
    pendingResponse.then(() => 'settled'),
    Promise.resolve('pending'),
  ])
  assert.equal(stateBeforeRelease, 'pending')
  assert.equal(received.appSecret, 'new-secret-for-test')
  releaseApply()
  const response = await pendingResponse
  assert.equal(response.status, 409)
  assert.match(response.json.error, /没有保留半完成配置/u)
  assert.doesNotMatch(response.json.error, /new-secret-for-test|controlled runtime apply failure/u)
  assert.deepEqual(harness.directReplaceCalls, [])
})

test('trusted setup route manages saved Workflows (list/launch/stop/delete)', async () => {
  const calls = []
  const workflowRecord = {
    schemaVersion: 1,
    id: 'wf-dashboard',
    revision: 3,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    name: 'Dashboard flow',
    description: 'd',
    ownerId: 'user:feishu:ou_test',
    scope: 'user',
    entryNodeId: 'start',
    nodes: [{ id: 'start', label: 'Start', kind: 'task', capability: 'start', outputs: ['result'] }],
    edges: [],
    inputs: [],
    outputs: [],
    policy: {
      budget: { maxDepth: 8, maxParallel: 2, maxFanOut: 2, maxMessages: 20, maxTokens: 20000, maxCostUnits: 100 },
      allowedCapabilities: ['start'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
  const harness = createHarness({
    async listWorkflows(actor) {
      calls.push(['list', actor])
      return [workflowRecord]
    },
    async launchWorkflow(workflowId, target, actor) {
      calls.push(['launch', workflowId, target.platform, actor])
      return { workflowRunId: 'run-1', rootTaskId: 'task-1', dispatched: [] }
    },
    async stopWorkflow(workflowId, actor) {
      calls.push(['stop', workflowId, actor])
      return 2
    },
    async deleteWorkflow(workflowId, actor) {
      calls.push(['delete', workflowId, actor])
      return true
    },
  })

  const listed = await harness.post({ action: 'workflow_list' })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.workflows[0].id, 'wf-dashboard')
  assert.equal(listed.json.workflows[0].revision, 3)

  const launched = await harness.post({ action: 'workflow_launch', workflowId: 'wf-dashboard' })
  assert.equal(launched.status, 200)
  assert.match(launched.json.message, /run-1/u)

  const stopped = await harness.post({ action: 'workflow_stop', workflowId: 'wf-dashboard' })
  assert.equal(stopped.status, 200)
  assert.match(stopped.json.message, /2/u)

  const deleted = await harness.post({ action: 'workflow_delete', workflowId: 'wf-dashboard' })
  assert.equal(deleted.status, 200)
  assert.match(deleted.json.message, /已停用/u)

  const missing = await harness.post({ action: 'workflow_launch' })
  assert.equal(missing.status, 400)

  const unknown = await harness.post({ action: 'workflow_purge' })
  assert.equal(unknown.status, 400)
  assert.deepEqual(calls, [
    ['list', 'local-dashboard'],
    ['launch', 'wf-dashboard', 'internal', 'local-dashboard'],
    ['stop', 'wf-dashboard', 'local-dashboard'],
    ['delete', 'wf-dashboard', 'local-dashboard'],
  ])
})
