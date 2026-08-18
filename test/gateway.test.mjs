import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway, discoveryCandidateFor, nextModelOverride, normalizeConfig } from '../dist/gateway.js'
import { createEnvelope } from '../dist/collaboration.js'

test('discovery accepts only an exact Feishu DM bind command', () => {
  const message = {
    id: 'feishu:message:1',
    target: { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_sender' },
    text: '/bind 123456',
    receivedAt: Date.now(),
  }
  const candidate = discoveryCandidateFor(message, '/bind 123456')
  assert.equal(candidate?.userId, 'ou_sender')
  assert.equal(candidate?.chatId, 'oc_chat')
  assert.equal(discoveryCandidateFor({ ...message, target: { ...message.target, platform: 'telegram' } }, '/bind 123456'), undefined)
  assert.equal(discoveryCandidateFor({ ...message, target: { ...message.target, chatType: 'group' } }, '/bind 123456'), undefined)
  assert.equal(discoveryCandidateFor({ ...message, text: '/bind 654321' }, '/bind 123456'), undefined)
})

test('profile switching can clear an old model override while /model replaces it', () => {
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, null), {})
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, undefined), { modelOverride: 'old-model' })
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, {
    provider: 'new-provider',
    model: 'new-model',
  }), { modelOverride: { provider: 'new-provider', model: 'new-model' } })
})

test('new DeepSeek-Bot environment names work while the legacy names remain available', () => {
  const previousUsers = process.env.DEEPSEEK_BOT_ALLOWED_USERS
  const previousToken = process.env.DEEPSEEK_BOT_TELEGRAM_TOKEN
  try {
    process.env.DEEPSEEK_BOT_ALLOWED_USERS = 'ou_env'
    process.env.DEEPSEEK_BOT_TELEGRAM_TOKEN = 'token_env'
    const config = normalizeConfig({ feishu: { enabled: false } })
    assert.deepEqual(config.access.userIds, ['ou_env'])
    assert.equal(config.telegram.token, 'token_env')
  } finally {
    if (previousUsers === undefined) delete process.env.DEEPSEEK_BOT_ALLOWED_USERS
    else process.env.DEEPSEEK_BOT_ALLOWED_USERS = previousUsers
    if (previousToken === undefined) delete process.env.DEEPSEEK_BOT_TELEGRAM_TOKEN
    else process.env.DEEPSEEK_BOT_TELEGRAM_TOKEN = previousToken
  }
})

test('typed public Bot API enforces per-Bot ACL and persists handoff approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-fleet-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { allowedUserIds: ['ou_allowed'], capabilities: ['research'] },
        writer: { fleetRole: 'synthesizer', approvalRequired: true },
      },
      collaboration: { enabled: true, approvalMode: 'auto-planned' },
    })
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_allowed' }
    await assert.rejects(() => gateway.sendBotMessage({
      from: 'user:ou_denied',
      to: 'researcher',
      instruction: 'research',
      replyTarget: { ...replyTarget, userId: 'ou_denied' },
    }), /not authorized/u)
    await assert.rejects(() => gateway.sendBotMessage({
      from: 'user:ou_allowed', to: 'writer', instruction: 'write', replyTarget,
    }), /requires an approved/u)
    const envelope = await gateway.sendBotMessage({
      from: 'user:ou_allowed', to: 'researcher', instruction: 'research', replyTarget,
    })
    const initial = await gateway.fleetStatus()
    assert.equal(initial.fleet.tasks.length, 1)
    assert.equal(initial.fleet.mailbox.queued, 1)
    const handoff = await gateway.requestHandoff({
      taskId: envelope.taskId,
      runId: envelope.runId,
      fromBot: 'researcher',
      toBot: 'writer',
      reason: 'write the report',
      requestedBy: 'user:ou_allowed',
      replyTarget,
    })
    assert.equal(handoff.status, 'requested')
    const pending = (await gateway.fleetStatus()).fleet.approvals.find(item => item.status === 'pending')
    assert.ok(pending?.code)
    assert.equal((await gateway.resolveApproval(pending.code, 'approved'))?.status, 'approved')
    const resolved = await gateway.fleetStatus()
    assert.equal(resolved.fleet.handoffs[0]?.status, 'accepted')
    assert.equal(resolved.fleet.mailbox.queued, 1)
    assert.equal(resolved.fleet.mailbox.failed, 1)
    assert.equal(resolved.fleet.runs.find(run => run.id === envelope.runId)?.status, 'cancelled')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('chat roster and Fleet status commands expose only the current requester records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-command-privacy-'))
  let gateway
  try {
    const registry = {
      get() { return undefined },
      async resume() { throw new Error('not found') },
      async create() { throw new Error('not used') },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a', 'ou_b'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        secret: { allowedUserIds: ['ou_a'], capabilities: ['private'] },
        publicbot: { capabilities: ['general'] },
      },
      collaboration: { enabled: true, approvalMode: 'never' },
    })
    const taskA = await gateway.tasks.createTask({ title: 'task-a-private', instruction: 'a', createdBy: 'user:feishu:ou_a', assignedTo: 'publicbot' })
    await gateway.tasks.createTask({ title: 'task-b-private', instruction: 'b', createdBy: 'user:feishu:ou_b', assignedTo: 'publicbot' })
    const approvalA = await gateway.approvals.create({ kind: 'workflow', requestedBy: 'user:feishu:ou_a', summary: 'approval-a-private', entityId: taskA.id })
    const approvalB = await gateway.approvals.create({ kind: 'workflow', requestedBy: 'user:feishu:ou_b', summary: 'approval-b-private', entityId: 'task-b' })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const sendCommand = async (id, userId, text) => inbound({
      id,
      target: { platform: 'feishu', chatId: `oc_${userId}`, chatType: 'dm', userId },
      text,
      receivedAt: Date.now(),
    })
    await sendCommand('privacy-bots-a', 'ou_a', '/bots')
    await sendCommand('privacy-bots-b', 'ou_b', '/bots')
    await sendCommand('privacy-tasks-a', 'ou_a', '/tasks')
    await sendCommand('privacy-approvals-a', 'ou_a', '/approvals')
    await sendCommand('privacy-mesh-a', 'ou_a', '/mesh')
    const deadline = Date.now() + 2_000
    while (sent.length < 5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    const forUser = userId => sent.filter(item => item.target.userId === userId).map(item => item.text)
    assert.ok(forUser('ou_a')[0]?.includes('@secret'))
    assert.equal(forUser('ou_b')[0]?.includes('@secret'), false)
    assert.ok(forUser('ou_a').some(text => text.includes('task-a-private') && !text.includes('task-b-private')))
    assert.ok(forUser('ou_a').some(text => text.includes(approvalA.code) && !text.includes(approvalB.code)))
    assert.ok(forUser('ou_a').some(text => text.includes('Tasks: 1')))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('approved handoff fences a still-running source before the target Bot completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-handoff-fence-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = {
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            setTimeout(() => {
              gateway.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${preset}-result` }] } } })
              gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            }, preset === 'source' ? 100 : 0)
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      profiles: { source: {}, target: {} },
      collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
    })
    const sent = []
    const transport = {
      platform: 'feishu', async start() {}, async stop() {},
      async send(_target, text) { sent.push(text) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' }
    const source = await gateway.sendBotMessage({
      from: 'user:feishu:ou_user', to: 'source', instruction: 'start work', replyTarget,
    })
    const runningDeadline = Date.now() + 2_000
    while ((await gateway.tasks.run(source.runId))?.status !== 'running' && Date.now() < runningDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const handoff = await gateway.requestHandoff({
      taskId: source.taskId,
      runId: source.runId,
      fromBot: 'source',
      toBot: 'target',
      reason: 'target should finish',
      requestedBy: 'user:feishu:ou_user',
      replyTarget,
    })
    assert.equal(handoff.status, 'accepted')
    const deadline = Date.now() + 3_000
    let fleet
    while (Date.now() < deadline) {
      fleet = (await gateway.fleetStatus()).fleet
      if (fleet.tasks.find(task => task.id === source.taskId)?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(fleet.runs.find(run => run.id === source.runId)?.status, 'cancelled')
    assert.ok(fleet.runs.some(run => run.taskId === source.taskId && run.botId === 'target' && run.status === 'completed'))
    assert.ok(sent.some(text => text.includes('target-result')))
    assert.equal(sent.some(text => text.includes('source-result')), false)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a selected verifier failure fails the Workflow instead of silently skipping verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-verifier-failure-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      profiles: { researcher: {}, reviewer: { fleetRole: 'verifier' }, writer: { fleetRole: 'synthesizer' } },
      collaboration: { enabled: true, approvalMode: 'never', botRunMaxAttempts: 1 },
    })
    const task = await gateway.tasks.createTask({
      title: 'verify', instruction: 'verify', createdBy: 'user:feishu:ou_user', assignedTo: 'researcher',
    })
    const workflow = await gateway.tasks.createWorkflow({
      taskId: task.id,
      createdBy: 'user:feishu:ou_user',
      instruction: 'verify',
      replyTarget: { platform: 'feishu', chatId: 'oc_dm', userId: 'ou_user' },
      workerBotIds: ['researcher'],
      verifierBotId: 'reviewer',
      synthesizerBotId: 'writer',
    })
    await gateway.tasks.transitionWorkflow(workflow.id, 'verifying', 'tester')
    const verifier = await gateway.tasks.createRun(task.id, 'reviewer', 1, { workflowId: workflow.id, phase: 'verify' })
    await gateway.tasks.startRun(verifier.id)
    await gateway.tasks.failRun(verifier.id, 'verification failed', false)
    await gateway.continueWorkflow(workflow.id)
    assert.equal((await gateway.tasks.workflow(workflow.id))?.status, 'failed')
    assert.equal((await gateway.tasks.task(task.id))?.status, 'failed')
    assert.equal((await gateway.tasks.runsForWorkflow(workflow.id, 'synthesize')).length, 0)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Grok-style Fleet runs execute, verify, and synthesize phases end to end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-workflow-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = {
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {
            queueMicrotask(() => {
              gateway.onSessionEvent(agent, {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: `${preset}-result` }] } },
              })
              gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            })
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    const ctx = {
      get(name) {
        if (name === 'agents') return registry
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
        return undefined
      },
    }
    gateway = new BotGateway(ctx, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { fleetRole: 'worker', capabilities: ['research'] },
        reviewer: { fleetRole: 'verifier', capabilities: ['review'] },
        writer: { fleetRole: 'synthesizer', capabilities: ['summary'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
    })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu',
      async start(handler) { inbound = handler },
      async stop() {},
      async send(target, text) { sent.push({ target, text }) },
      status() { return { running: true, connected: true } },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    assert.ok(inbound)
    await inbound({
      id: 'message_fleet_1',
      target: { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' },
      text: '/fleet research this issue',
      receivedAt: Date.now(),
    })
    const deadline = Date.now() + 5_000
    let workflow
    while (Date.now() < deadline) {
      workflow = (await gateway.fleetStatus()).fleet.workflows[0]
      if (workflow?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(workflow?.status, 'completed')
    const workflowDetail = await gateway.tasks.workflow(workflow.id)
    assert.equal(workflowDetail?.outputs.length, 3)
    assert.deepEqual(workflowDetail?.outputs.map(item => item.phase), ['execute', 'verify', 'synthesize'])
    assert.ok(sent.some(item => item.text.includes('Fleet 最终结果')))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot model failure creates a fresh Run and really retries after backoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-retry-'))
  let gateway
  try {
    const agents = new Map()
    let turns = 0
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions }) {
        const agent = {
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            turns += 1
            const current = turns
            queueMicrotask(() => {
              if (current === 1) {
                gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'error' } } })
              } else {
                gateway.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'retry-success' }] } } })
                gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
              }
            })
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    const ctx = { get: name => name === 'agents' ? registry : undefined }
    gateway = new BotGateway(ctx, {
      stateDir: root,
      access: { userIds: ['ou_user'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      profiles: { researcher: { capabilities: ['research'] } },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        botRunMaxAttempts: 2,
        mailboxRetryBaseMs: 50,
        mailboxRetryMaxMs: 50,
        mailboxLeaseMs: 5_000,
      },
    })
    let inbound
    const sent = []
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {},
      async send(_target, text) { sent.push(text) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    await inbound({
      id: 'message_retry_1',
      target: { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' },
      text: '@researcher retry this', receivedAt: Date.now(),
    })
    const deadline = Date.now() + 5_000
    let fleet
    while (Date.now() < deadline) {
      fleet = (await gateway.fleetStatus()).fleet
      if (fleet.tasks[0]?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(turns, 2)
    assert.equal(fleet.tasks[0]?.status, 'completed')
    assert.deepEqual(fleet.runs.map(run => run.status).sort(), ['completed', 'failed'])
    assert.equal(fleet.mailbox.failed, 1)
    assert.equal(fleet.mailbox.completed, 1)
    assert.ok(sent.some(text => text.includes('retry-success')))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('restart repairs a mailbox-completed Run whose output commit was interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-interrupted-commit-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: { researcher: { capabilities: ['research'] } },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      botRunMaxAttempts: 2,
      mailboxRetryBaseMs: 50,
      mailboxRetryMaxMs: 50,
      mailboxLeaseMs: 5_000,
    },
  }
  let initial
  let recovered
  try {
    initial = new BotGateway({}, config)
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' }
    const envelope = await initial.sendBotMessage({
      from: 'user:feishu:ou_user', to: 'researcher', instruction: 'recover this', replyTarget,
    })
    const lease = await initial.mailbox.claim(['researcher'], 'crashed-worker')
    assert.ok(lease)
    const acknowledged = await initial.mailbox.acknowledge(lease)
    assert.ok(acknowledged)
    const running = await initial.mailbox.start({ ...lease, item: acknowledged })
    assert.ok(running)
    await initial.tasks.startRun(envelope.runId)
    await initial.mailbox.complete({ ...lease, item: running })
    await initial.stop()
    initial = undefined

    const agents = new Map()
    let turns = 0
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions }) {
        const agent = {
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            turns += 1
            queueMicrotask(() => {
              recovered.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'recovered-result' }] } } })
              recovered.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            })
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    recovered = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, config)
    const sent = []
    const transport = {
      platform: 'feishu', async start() {}, async stop() {},
      async send(_target, text) { sent.push(text) },
    }
    recovered.transports = [transport]
    recovered.transportByPlatform.set('feishu', transport)
    await recovered.start()
    const deadline = Date.now() + 5_000
    let fleet
    while (Date.now() < deadline) {
      fleet = (await recovered.fleetStatus()).fleet
      if (
        fleet.tasks.find(task => task.id === envelope.taskId)?.status === 'completed' &&
        sent.some(text => text.includes('recovered-result'))
      ) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(turns, 1)
    assert.equal(fleet.tasks.find(task => task.id === envelope.taskId)?.status, 'completed')
    assert.deepEqual(fleet.runs.filter(run => run.taskId === envelope.taskId).map(run => run.status).sort(), ['completed', 'failed'])
    assert.ok(sent.some(text => text.includes('recovered-result')))
  } finally {
    if (initial) await initial.stop()
    if (recovered) await recovered.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('task detail, cancellation, and replay preserve ownership and create fresh identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-task-control-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      profiles: {
        researcher: { fleetRole: 'worker' },
        reviewer: { fleetRole: 'verifier' },
        writer: { fleetRole: 'synthesizer' },
      },
      collaboration: { enabled: true, approvalMode: 'never' },
    })
    const target = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_owner' }
    const owner = 'user:feishu:ou_owner'
    const task = await gateway.tasks.createTask({
      title: 'controlled task', instruction: 'keep this instruction', createdBy: owner, assignedTo: 'researcher',
    })
    const workflow = await gateway.tasks.createWorkflow({
      taskId: task.id,
      createdBy: owner,
      instruction: task.instruction,
      replyTarget: target,
      workerBotIds: ['researcher'],
      verifierBotId: 'reviewer',
      synthesizerBotId: 'writer',
    })
    const run = await gateway.tasks.createRun(task.id, 'researcher', 1, { workflowId: workflow.id, phase: 'execute' })
    const envelope = createEnvelope({
      from: owner,
      to: 'researcher',
      taskId: task.id,
      runId: run.id,
      attemptId: run.attemptId,
      correlationId: workflow.id,
      payload: { instruction: task.instruction, requester: owner, replyTarget: target, workflowId: workflow.id, workflowPhase: 'execute' },
    })
    await gateway.mailbox.enqueue(envelope, `control:${task.id}`)

    assert.equal(await gateway.fleetTaskDetail(task.id, 'user:feishu:ou_other'), undefined)
    const detail = await gateway.fleetTaskDetail(task.id, owner)
    assert.equal(detail?.task.instruction, 'keep this instruction')
    assert.equal(detail?.workflow?.id, workflow.id)
    assert.equal(detail?.deliveries.length, 1)
    assert.equal('payload' in detail.deliveries[0], false)

    const cancelled = await gateway.cancelFleetTask(task.id, owner)
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal((await gateway.tasks.workflow(workflow.id))?.status, 'cancelled')
    assert.equal((await gateway.tasks.run(run.id))?.status, 'cancelled')
    assert.equal((await gateway.mailbox.snapshot())[0]?.state, 'failed')
    assert.equal(await gateway.cancelFleetTask(task.id, owner), undefined)

    const replay = await gateway.replayFleetTask(task.id, 'local-dashboard')
    assert.equal(replay?.status, 'started')
    assert.notEqual(replay?.taskId, task.id)
    assert.notEqual(replay?.workflowId, workflow.id)
    const replayDetail = await gateway.fleetTaskDetail(replay.taskId)
    assert.equal(replayDetail?.task.instruction, task.instruction)
    assert.equal(replayDetail?.workflow?.workerBotIds[0], 'researcher')
    assert.ok(replayDetail?.runs.every(candidate => candidate.id !== run.id))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('scoped model handoff tool pauses for approval and resumes with the target Bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-model-handoff-'))
  let gateway
  try {
    const agents = new Map()
    const toolsBySession = new Map()
    let toolResult
    let concluded = false
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, agentOptions, meta, setup }) {
        const id = String(sessionId)
        const runtime = { register(tool) { toolsBySession.set(id, tool); return () => {} } }
        const agentCtx = { get(name) { return name === 'tools' ? runtime : undefined } }
        if (setup) await setup(agentCtx)
        const preset = meta?.agentPreset ?? 'unknown'
        const agent = {
          id,
          ctx: agentCtx,
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {
            if (preset === 'source') {
              queueMicrotask(async () => {
                const tool = toolsBySession.get(id)
                assert.equal(tool?.name, 'bot_fleet_handoff')
                assert.equal('taskId' in tool.parameters.properties, false)
                toolResult = await tool.execute(
                  { toBot: 'target', reason: 'target owns the finishing skill' },
                  {
                    signal: new AbortController().signal,
                    agent,
                    concludeTurn() { concluded = true },
                    deferContext() {},
                  },
                )
                gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
              })
              return
            }
            queueMicrotask(() => {
              gateway.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'target-finished' }] } } })
              gateway.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            })
          },
        }
        agents.set(id, agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      profiles: { source: {}, target: { approvalRequired: true } },
      collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
    })
    const sent = []
    const transport = {
      platform: 'feishu', async start() {}, async stop() {},
      async send(_target, text) { sent.push(text) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' }
    const source = await gateway.sendBotMessage({
      from: 'user:feishu:ou_user', to: 'source', instruction: 'delegate when appropriate', replyTarget,
    })

    const pausedDeadline = Date.now() + 3_000
    let approval
    while (Date.now() < pausedDeadline) {
      approval = (await gateway.approvals.pending())[0]
      if (approval && (await gateway.tasks.run(source.runId))?.status === 'cancelled') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(toolResult?.status, 'pending-approval')
    assert.equal(concluded, true)
    assert.ok(approval?.code)
    assert.equal((await gateway.tasks.task(source.taskId))?.status, 'waiting')

    assert.equal((await gateway.resolveApproval(approval.code, 'approved'))?.status, 'approved')
    const completedDeadline = Date.now() + 3_000
    let taskStatus
    let handoffStatus
    while (Date.now() < completedDeadline) {
      taskStatus = (await gateway.tasks.task(source.taskId))?.status
      handoffStatus = (await gateway.tasks.handoff(approval.entityId))?.status
      if (taskStatus === 'completed' && handoffStatus === 'completed' && sent.some(text => text.includes('target-finished'))) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const snapshot = await gateway.tasks.snapshot()
    assert.equal(taskStatus, 'completed')
    assert.equal(handoffStatus, 'completed')
    assert.ok(snapshot.runs.some(run => run.botId === 'target' && run.status === 'completed'))
    assert.ok(sent.some(text => text.includes('target-finished')))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('restart replays an approved workflow decision exactly once after the side effect was interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-approved-workflow-recovery-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    profiles: { worker: { fleetRole: 'worker' } },
    collaboration: { enabled: true, approvalMode: 'always', mailboxLeaseMs: 5_000 },
  }
  let initial
  let recovered
  try {
    initial = new BotGateway({}, config)
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' }
    const task = await initial.tasks.createTask({
      title: 'recover approved workflow', instruction: 'recover approved workflow',
      createdBy: 'user:feishu:ou_user', assignedTo: 'worker',
    })
    let workflow = await initial.tasks.createWorkflow({
      taskId: task.id,
      createdBy: 'user:feishu:ou_user',
      instruction: task.instruction,
      replyTarget,
      workerBotIds: ['worker'],
      synthesizerBotId: 'worker',
      status: 'pending-approval',
    })
    const approval = await initial.approvals.create({
      kind: 'workflow', requestedBy: task.createdBy, summary: 'recover workflow', entityId: workflow.id,
    })
    workflow = await initial.tasks.setWorkflowApproval(workflow.id, approval.id)
    assert.ok(workflow)
    // This deliberately bypasses BotGateway.resolveApproval(): the durable
    // decision lands, then the old process dies before dispatching a Run.
    assert.equal((await initial.approvals.resolveByCode(approval.code, 'approved', task.createdBy))?.status, 'approved')
    assert.equal((await initial.tasks.runsForWorkflow(workflow.id)).length, 0)
    await initial.stop()
    initial = undefined

    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions }) {
        const agent = {
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            queueMicrotask(() => {
              recovered.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'workflow-recovered' }] } } })
              recovered.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            })
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    recovered = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, config)
    const transport = {
      platform: 'feishu', async start() {}, async stop() {}, async send() {},
    }
    recovered.transports = [transport]
    recovered.transportByPlatform.set('feishu', transport)
    await recovered.start()

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const taskStatus = (await recovered.tasks.task(task.id))?.status
      const workflowStatus = (await recovered.tasks.workflow(workflow.id))?.status
      if (taskStatus === 'completed' && workflowStatus === 'completed') break
      await recovered.fleetStatus()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    for (let index = 0; index < 5; index += 1) await recovered.fleetStatus()
    const runs = await recovered.tasks.runsForWorkflow(workflow.id)
    assert.equal((await recovered.tasks.workflow(workflow.id))?.status, 'completed')
    assert.equal((await recovered.tasks.task(task.id))?.status, 'completed')
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'completed')
  } finally {
    if (initial) await initial.stop()
    if (recovered) await recovered.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('restart replays an approved handoff once without resetting its target Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-approved-handoff-recovery-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    profiles: { source: {}, target: { approvalRequired: true } },
    collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
  }
  let initial
  let recovered
  try {
    initial = new BotGateway({}, config)
    const replyTarget = { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' }
    const source = await initial.sendBotMessage({
      from: 'user:feishu:ou_user', to: 'source', instruction: 'handoff and recover', replyTarget,
    })
    const handoff = await initial.requestHandoff({
      taskId: source.taskId,
      runId: source.runId,
      fromBot: 'source',
      toBot: 'target',
      reason: 'target owns the finishing skill',
      requestedBy: 'user:feishu:ou_user',
      replyTarget,
    })
    const approval = (await initial.approvals.pending()).find(item => item.entityId === handoff.id)
    assert.ok(approval)
    // Match the model-tool pause: the source turn is fenced before waiting for
    // a human decision. Then persist only the decision and simulate a crash.
    await initial.mailbox.cancelRun(source.runId, 'waiting for handoff approval')
    await initial.tasks.cancelRun(source.runId, 'waiting for handoff approval', 'source')
    assert.equal((await initial.approvals.resolveByCode(approval.code, 'approved', 'user:feishu:ou_user'))?.status, 'approved')
    assert.equal((await initial.tasks.handoff(handoff.id))?.status, 'requested')
    await initial.stop()
    initial = undefined

    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions }) {
        const agent = {
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            queueMicrotask(() => {
              recovered.onSessionEvent(agent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'handoff-recovered' }] } } })
              recovered.onSessionEvent(agent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
            })
          },
        }
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    recovered = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, config)
    const transport = {
      platform: 'feishu', async start() {}, async stop() {}, async send() {},
    }
    recovered.transports = [transport]
    recovered.transportByPlatform.set('feishu', transport)
    await recovered.start()

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && (await recovered.tasks.task(source.taskId))?.status !== 'completed') {
      await recovered.fleetStatus()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    for (let index = 0; index < 5; index += 1) await recovered.fleetStatus()
    const snapshot = await recovered.tasks.snapshot()
    const targetRuns = snapshot.runs.filter(run => run.parentRunId === source.runId && run.botId === 'target')
    const queuedAudits = snapshot.audits.filter(audit => audit.action === 'handoff.message_queued' && audit.data?.handoffId === handoff.id)
    assert.equal((await recovered.tasks.task(source.taskId))?.status, 'completed')
    assert.equal((await recovered.tasks.handoff(handoff.id))?.status, 'completed')
    assert.equal(targetRuns.length, 1)
    assert.equal(targetRuns[0]?.status, 'completed')
    assert.equal(queuedAudits.length, 1)
  } finally {
    if (initial) await initial.stop()
    if (recovered) await recovered.stop()
    await rm(root, { recursive: true, force: true })
  }
})
