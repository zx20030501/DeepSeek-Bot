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
    async call(method, headers = {}, remoteAddress = '127.0.0.1') {
      const req = Readable.from([])
      req.method = method
      req.headers = {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        ...headers,
      }
      req.socket = { remoteAddress }
      return new Promise(resolve => {
        const response = { status: 0, headers: {}, body: '' }
        const res = {
          writeHead(status, hdrs = {}) { response.status = status; response.headers = hdrs },
          end(chunk = '') {
            response.body += String(chunk)
            resolve({
              ...response,
              json: response.body === '' ? undefined : JSON.parse(response.body),
            })
          },
        }
        handler(req, res)
      })
    },
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

test('setup route registers owner DSH web conversation sessions on demand', async () => {
  const calls = []
  const harness = createHarness({
    async registerLocalWebOwnerSession(sessionId) {
      calls.push(sessionId)
    },
  })
  const missing = await harness.post({ action: 'register_owner_web_session' })
  assert.equal(missing.status, 400)
  const response = await harness.post({
    action: 'register_owner_web_session',
    sessionId: 'owner-programming-session',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, ['owner-programming-session'])
  assert.match(response.json.message, /Bot 创建工具/u)
})

test('setup route save_fleet_config merges fleet flags without credential body', async () => {
  const calls = []
  const harness = createHarness({
    async saveAndApplySettings(settings) {
      calls.push(settings.collaboration.features.webChatBotCreation)
    },
  })
  const response = await harness.post({
    action: 'save_fleet_config',
    enableFleet: true,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [true])
  assert.match(response.json.message, /Fleet/u)
})

test('setup route bot_create_draft and owner_web_command delegate to gateway actions', async () => {
  const calls = []
  const harness = createHarness({
    async registerLocalWebOwnerSession(sessionId) {
      calls.push(['register', sessionId])
    },
    async createWebDashboardBotDraft(input) {
      calls.push(['draft', input.handle])
      return { status: 'draft', botId: 'bot_1', handle: input.handle, confirmationCode: 'ABCD2345', message: 'draft ok' }
    },
    async dispatchOwnerWebCommand(sessionId, text) {
      calls.push(['command', sessionId, text])
    },
  })
  const draft = await harness.post({
    action: 'bot_create_draft',
    sessionId: 'owner-session',
    handle: 'analyst',
    title: 'Analyst',
  })
  assert.equal(draft.status, 200)
  assert.equal(draft.json.draft.handle, 'analyst')
  const command = await harness.post({
    action: 'owner_web_command',
    sessionId: 'owner-session',
    text: '/fleet research this',
  })
  assert.equal(command.status, 200)
  assert.match(draft.json.message, /确认激活/u)
  assert.deepEqual(calls, [
    ['register', 'owner-session'],
    ['draft', 'analyst'],
    ['command', 'owner-session', '/fleet research this'],
  ])
})

test('setup route bot_update patches a Bot archive without slash commands', async () => {
  const calls = []
  const harness = createHarness({
    async updateWebDashboardBot(input) {
      calls.push(input)
      return { botId: 'bot_1', handle: input.handle, version: 3, status: 'active' }
    },
  })
  const missing = await harness.post({ action: 'bot_update' })
  assert.equal(missing.status, 400)
  const response = await harness.post({
    action: 'bot_update',
    handle: 'analyst',
    title: 'Researcher',
    description: 'writes briefs',
    capabilities: 'research, writing',
    soul: 'be concise',
    fleetRole: 'worker',
  })
  assert.equal(response.status, 200)
  assert.match(response.json.message, /@analyst/u)
  assert.deepEqual(calls, [{
    handle: 'analyst',
    title: 'Researcher',
    description: 'writes briefs',
    capabilities: ['research', 'writing'],
    soul: 'be concise',
    role: 'worker',
  }])
})

test('setup route fleet_dispatch sends a Bot task without owner-session command injection', async () => {
  const calls = []
  const harness = createHarness({
    async dispatchWebDashboardTask(to, instruction) {
      calls.push([to, instruction])
      return { handle: to, taskId: 'task_1' }
    },
  })
  const missing = await harness.post({ action: 'fleet_dispatch' })
  assert.equal(missing.status, 400)
  const response = await harness.post({
    action: 'fleet_dispatch',
    to: 'analyst',
    instruction: 'write a brief',
  })
  assert.equal(response.status, 200)
  assert.match(response.json.message, /已派任务给 @analyst/u)
  assert.deepEqual(calls, [['analyst', 'write a brief']])
})

test('setup route fleet_plan and fleet_team_dispatch skip slash-command injection', async () => {
  const calls = []
  const harness = createHarness({
    async planWebDashboardTask(instruction) {
      calls.push(['plan', instruction])
      return { workflowId: 'wf_1', taskId: 'task_2', status: 'pending-approval' }
    },
    async dispatchWebDashboardTeamTask(teamId, instruction) {
      calls.push(['team', teamId, instruction])
      return { teamId }
    },
  })
  const missingPlan = await harness.post({ action: 'fleet_plan' })
  assert.equal(missingPlan.status, 400)
  const planned = await harness.post({ action: 'fleet_plan', instruction: 'research this issue' })
  assert.equal(planned.status, 200)
  assert.match(planned.json.message, /执行计划/u)
  const missingTeam = await harness.post({ action: 'fleet_team_dispatch', teamId: 'core' })
  assert.equal(missingTeam.status, 400)
  const team = await harness.post({ action: 'fleet_team_dispatch', teamId: 'core', instruction: 'draft the brief' })
  assert.equal(team.status, 200)
  assert.match(team.json.message, /Team/u)
  assert.deepEqual(calls, [
    ['plan', 'research this issue'],
    ['team', 'core', 'draft the brief'],
  ])
})

test('setup route fleet_room_dispatch and routine_create skip slash commands', async () => {
  const calls = []
  const harness = createHarness({
    async dispatchWebDashboardRoomTask(botIds, instruction) {
      calls.push(['room', [...botIds], instruction])
      return { botIds: [...botIds] }
    },
    async createWebDashboardRoutine(input) {
      calls.push(['routine', input])
      return {
        id: 'routine_1',
        name: input.name,
        cron: input.cron,
        timezone: input.timezone ?? 'Asia/Shanghai',
        status: 'enabled',
        nextRunAt: Date.now() + 60_000,
      }
    },
  })
  const missingRoom = await harness.post({ action: 'fleet_room_dispatch', instruction: 'hi' })
  assert.equal(missingRoom.status, 400)
  const room = await harness.post({
    action: 'fleet_room_dispatch',
    botIds: ['analyst', 'writer'],
    instruction: 'continue the brief',
  })
  assert.equal(room.status, 200)
  assert.match(room.json.message, /群聊/u)
  const missingRoutine = await harness.post({ action: 'routine_create', name: 'daily' })
  assert.equal(missingRoutine.status, 400)
  const routine = await harness.post({
    action: 'routine_create',
    name: 'daily brief',
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    to: 'analyst',
    instruction: 'write the morning brief',
  })
  assert.equal(routine.status, 200)
  assert.match(routine.json.message, /daily brief/u)
  assert.deepEqual(calls, [
    ['room', ['analyst', 'writer'], 'continue the brief'],
    ['routine', {
      name: 'daily brief',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      to: 'analyst',
      instruction: 'write the morning brief',
    }],
  ])
})

test('setup route routine_update enables and deletes without slash commands', async () => {
  const calls = []
  const harness = createHarness({
    async updateRoutine(routineId, patch) {
      calls.push(['update', routineId, patch])
      return { id: routineId, status: patch.enabled === true ? 'enabled' : 'disabled' }
    },
    async deleteRoutine(routineId) {
      calls.push(['delete', routineId])
      return true
    },
  })
  const disabled = await harness.post({ action: 'routine_update', routineId: 'rtn_1', enabled: false })
  assert.equal(disabled.status, 200)
  assert.match(disabled.json.message, /停用/u)
  const removed = await harness.post({ action: 'routine_update', routineId: 'rtn_1', delete: true })
  assert.equal(removed.status, 200)
  assert.match(removed.json.message, /删除/u)
  const missing = await harness.post({ action: 'routine_update' })
  assert.equal(missing.status, 400)
  assert.deepEqual(calls, [
    ['update', 'rtn_1', { enabled: false }],
    ['delete', 'rtn_1'],
  ])
})

test('setup route allows Cursor webview Origin and echoes CORS on loopback GET', async () => {
  const harness = createHarness({})
  const response = await harness.call('GET', {
    origin: 'vscode-webview://1a2b3c',
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['access-control-allow-origin'], 'vscode-webview://1a2b3c')
  const preflight = await harness.call('OPTIONS', {
    origin: 'vscode-webview://1a2b3c',
    'sec-fetch-site': 'cross-site',
    'access-control-request-method': 'POST',
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], 'vscode-webview://1a2b3c')
  const blocked = await harness.call('GET', { origin: 'https://evil.example' })
  assert.equal(blocked.status, 403)
})

test('setup route team_delete removes a Team without slash commands', async () => {
  const calls = []
  const harness = createHarness({
    async deleteWebDashboardTeam(teamId) {
      calls.push(teamId)
    },
  })
  const missing = await harness.post({ action: 'team_delete' })
  assert.equal(missing.status, 400)
  const removed = await harness.post({ action: 'team_delete', teamId: 'team_1' })
  assert.equal(removed.status, 200)
  assert.match(removed.json.message, /删除/u)
  assert.deepEqual(calls, ['team_1'])
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
