import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway, discoveryCandidateFor, nextModelOverride, normalizeConfig } from '../dist/gateway.js'
import { BotMailbox, createEnvelope } from '../dist/collaboration.js'

function withMockSession(agent) {
  const events = []
  const session = {
    get events() { return events },
    get seq() { return events.length },
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
  }
  agent.session = session
  agent.whenIdle ??= async () => {}
  const followup = agent.followup.bind(agent)
  agent.followup = (...args) => {
    const latestTurn = events.reduce((latest, event) => Math.max(latest, Number(event.data?.turn ?? 0)), 0)
    agent.__mockTurn = latestTurn + 1
    session.append('turn/start', { turn: agent.__mockTurn })
    agent.status = 'running'
    return followup(...args)
  }
  return agent
}

function emitMockAgentEvent(gateway, agent, type, data) {
  assert.ok(Number.isSafeInteger(agent.__mockTurn), `mock Agent has no active turn for ${type}`)
  const eventData = type === 'assistant/message'
    ? { turn: agent.__mockTurn, step: 1, ...data }
    : { turn: agent.__mockTurn, ...data }
  const event = agent.session.append(type, eventData)
  if (type === 'turn/end') agent.status = 'idle'
  gateway.onSessionEvent(agent, event)
  return event
}

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

test('Fleet v2 feature flags are secure-off by default and opt in individually', () => {
  const defaults = normalizeConfig({ feishu: { enabled: false }, telegram: { enabled: false } })
  assert.deepEqual(defaults.collaboration.features, {
    dynamicRegistry: false,
    chatBotCreation: false,
    webChatBotCreation: false,
    peerMessaging: false,
    managerAgent: false,
    savedWorkflows: false,
    externalRuntimes: false,
    routines: false,
  })
  const enabled = normalizeConfig({
    feishu: { enabled: false },
    telegram: { enabled: false },
    collaboration: { features: { dynamicRegistry: true, peerMessaging: true } },
  })
  assert.equal(enabled.collaboration.features.dynamicRegistry, true)
  assert.equal(enabled.collaboration.features.peerMessaging, true)
  assert.equal(enabled.collaboration.features.managerAgent, false)
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
        const agent = withMockSession({
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            setTimeout(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', { message: { content: [{ type: 'text', text: `${preset}-result` }] } })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            }, preset === 'source' ? 100 : 0)
          },
        })
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
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {
            queueMicrotask(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', {
                message: { content: [{ type: 'text', text: `${preset}-result` }] },
              })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            })
          },
        })
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
        const agent = withMockSession({
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            turns += 1
            const current = turns
            queueMicrotask(() => {
              if (current === 1) {
                emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'error' } })
              } else {
                emitMockAgentEvent(gateway, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'retry-success' }] } })
                emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
              }
            })
          },
        })
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
    await gateway.sendBotMessage({
      from: 'user:ou_user',
      to: 'researcher',
      instruction: 'retry this',
      replyTarget: { platform: 'feishu', chatId: 'oc_dm', chatType: 'dm', userId: 'ou_user' },
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
    const completedDelivery = (await gateway.mailbox.snapshot()).find(item => item.state === 'completed')
    assert.equal(completedDelivery?.envelope.schemaVersion, 1)
    assert.equal(completedDelivery?.envelope.fromAddress?.type, 'user')
    assert.equal(completedDelivery?.envelope.traceId, completedDelivery?.envelope.correlationId)
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
        const agent = withMockSession({
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            turns += 1
            queueMicrotask(() => {
              emitMockAgentEvent(recovered, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'recovered-result' }] } })
              emitMockAgentEvent(recovered, agent, 'turn/end', { reason: { kind: 'completed' } })
            })
          },
        })
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
        const agent = withMockSession({
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
                emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
              })
              return
            }
            queueMicrotask(() => {
              emitMockAgentEvent(gateway, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'target-finished' }] } })
              emitMockAgentEvent(gateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            })
          },
        })
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
      if (approval
        && (await gateway.tasks.run(source.runId))?.status === 'cancelled'
        && (await gateway.tasks.task(source.taskId))?.status === 'waiting') break
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
        const agent = withMockSession({
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            queueMicrotask(() => {
              emitMockAgentEvent(recovered, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'workflow-recovered' }] } })
              emitMockAgentEvent(recovered, agent, 'turn/end', { reason: { kind: 'completed' } })
            })
          },
        })
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
        const agent = withMockSession({
          id: String(sessionId), status: 'idle', options: agentOptions ?? {}, cancel() {},
          followup() {
            queueMicrotask(() => {
              emitMockAgentEvent(recovered, agent, 'assistant/message', { message: { content: [{ type: 'text', text: 'handoff-recovered' }] } })
              emitMockAgentEvent(recovered, agent, 'turn/end', { reason: { kind: 'completed' } })
            })
          },
        })
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

test('dynamic Bot activation is owner-scoped, restart-safe, and does not replay over a later disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-dynamic-restart-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    profiles: { staticbot: { title: 'Static Bot' } },
    collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
  }
  const ownerTarget = { platform: 'feishu', chatId: 'oc_owner', chatType: 'dm', userId: 'ou_owner' }
  const otherTarget = { platform: 'feishu', chatId: 'oc_other', chatType: 'dm', userId: 'ou_other' }
  let initial
  let recovered
  let conflicted
  try {
    initial = new BotGateway({}, config)
    await initial.start()
    const draft = await initial.createDynamicBotDraft({
      handle: 'analyst',
      title: 'Data Analyst',
      capabilities: ['analysis'],
      role: 'worker',
    }, ownerTarget)
    assert.equal(draft.status, 'draft')
    assert.match(draft.confirmationCode, /^[A-Z0-9]{8}$/u)
    assert.equal(initial.directory.get('analyst'), undefined)
    await assert.rejects(
      initial.createDynamicBotDraft({ handle: 'staticbot', title: 'Conflict' }, ownerTarget),
      /静态配置占用/u,
    )

    const duplicate = await initial.createDynamicBotDraft({ handle: 'analyst', title: 'Ignored Retry' }, ownerTarget)
    assert.equal(duplicate.botId, draft.botId)
    assert.equal(duplicate.confirmationCode, draft.confirmationCode)
    await assert.rejects(
      initial.createDynamicBotDraft({ handle: 'analyst', title: 'Hijack' }, otherTarget),
      /already|占用/u,
    )

    const approved = await initial.resolveApproval(draft.confirmationCode, 'approved', 'local-dashboard')
    assert.equal(approved?.kind, 'bot-activation')
    assert.equal(initial.directory.canInvoke('analyst', ownerTarget), true)
    assert.equal(initial.directory.canInvoke('analyst', otherTarget), false)
    const sameRawIdOtherPlatform = { platform: 'telegram', chatId: 'ou_owner', chatType: 'dm', userId: 'ou_owner' }
    assert.equal(initial.directory.canInvoke('analyst', sameRawIdOtherPlatform), false)
    await assert.rejects(initial.sendBotMessage({
      from: 'user:telegram:ou_owner', to: 'analyst', instruction: 'cross-platform attempt', replyTarget: sameRawIdOtherPlatform,
    }), /not authorized/u)
    assert.ok(initial.status().bots.some(bot => bot.id === 'analyst'))
    const analystRuntime = (await initial.fleetStatus()).fleet.registryBots.find(bot => bot.id === draft.botId)
    assert.equal(analystRuntime.runtimeReady, true)
    assert.equal(analystRuntime.runtimeSource, 'dynamic')
    assert.equal(analystRuntime.runtimeDefinitionId, draft.botId)
    await assert.rejects(initial.reconfigure({
      ...config,
      profiles: { ...config.profiles, analyst: { title: 'Static Analyst' } },
    }), /动态 Bot|墓碑|占用/u)
    assert.equal(initial.directory.get('analyst')?.title, 'Data Analyst')

    const activeWork = await initial.sendBotMessage({
      from: 'user:feishu:ou_owner', to: 'analyst', instruction: 'hold this task', replyTarget: ownerTarget,
    })
    await assert.rejects(
      initial.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner'),
      /未结束任务|正在运行任务/u,
    )
    assert.equal((await initial.cancelFleetTask(activeWork.taskId, 'user:feishu:ou_owner'))?.status, 'cancelled')

    const pendingTask = await initial.tasks.createTask({
      title: 'pending reservation', instruction: 'not dispatched yet', createdBy: 'user:feishu:ou_owner', assignedTo: 'analyst',
    })
    await assert.rejects(
      initial.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner'),
      /未结束任务/u,
    )
    await initial.tasks.cancelTask(pendingTask.id, 'user:feishu:ou_owner')

    const createTask = initial.tasks.createTask.bind(initial.tasks)
    let releaseAdmission
    const admissionReleased = new Promise(resolve => { releaseAdmission = resolve })
    let reachedAdmission
    const admissionReached = new Promise(resolve => { reachedAdmission = resolve })
    initial.tasks.createTask = async input => {
      reachedAdmission()
      await admissionReleased
      return createTask(input)
    }
    const racingSend = initial.sendBotMessage({
      from: 'user:feishu:ou_owner', to: 'analyst', instruction: 'race with disable', replyTarget: ownerTarget,
    })
    await admissionReached
    await initial.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner')
    releaseAdmission()
    await assert.rejects(racingSend, /no longer active/u)
    initial.tasks.createTask = createTask
    const racedTask = (await initial.tasks.snapshot()).tasks.find(task => task.instruction === 'race with disable')
    assert.equal(racedTask?.status, 'cancelled')
    await initial.setDynamicBotStatus(draft.botId, 'active', 'user:feishu:ou_owner')

    const recoverDraft = await initial.createDynamicBotDraft({ handle: 'recoverbot', title: 'Recover Bot' }, ownerTarget)
    assert.equal((await initial.approvals.resolveByCode(recoverDraft.confirmationCode, 'approved', 'user:feishu:ou_owner'))?.status, 'approved')
    assert.equal((await initial.registry.get(recoverDraft.botId))?.definition.status, 'draft')

    const changedDraft = await initial.createDynamicBotDraft({ handle: 'changedbot', title: 'Approved Title' }, ownerTarget)
    assert.equal((await initial.approvals.resolveByCode(changedDraft.confirmationCode, 'approved', 'user:feishu:ou_owner'))?.status, 'approved')
    const changedRevision = await initial.updateDynamicBotDraft({ handle: 'changedbot', title: 'Changed After Approval' }, ownerTarget)
    assert.notEqual(changedRevision.confirmationCode, changedDraft.confirmationCode)
    assert.equal((await initial.registry.get(changedDraft.botId))?.definition.status, 'draft')

    await initial.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner')
    assert.equal(initial.directory.get('analyst'), undefined)
    await initial.stop()
    initial = undefined

    recovered = new BotGateway({}, config)
    await recovered.start()
    assert.equal((await recovered.registry.get(draft.botId))?.definition.status, 'disabled')
    assert.equal(recovered.directory.get('analyst'), undefined)
    assert.equal((await recovered.registry.get(recoverDraft.botId))?.definition.status, 'active')
    assert.equal(recovered.directory.canInvoke('recoverbot', ownerTarget), true)
    assert.equal((await recovered.registry.get(changedDraft.botId))?.definition.status, 'draft')
    assert.equal((await recovered.registry.get(changedDraft.botId))?.revision.title, 'Changed After Approval')
    assert.equal(recovered.directory.get('changedbot'), undefined)
    assert.equal((await recovered.resolveApproval(changedRevision.confirmationCode, 'approved', 'local-dashboard'))?.status, 'approved')
    assert.equal((await recovered.registry.get(changedDraft.botId))?.definition.status, 'active')
    await recovered.setDynamicBotStatus(draft.botId, 'active', 'user:feishu:ou_owner')
    assert.equal(recovered.directory.canInvoke('analyst', ownerTarget), true)

    const grave = await recovered.createDynamicBotDraft({ handle: 'grave', title: 'Tombstone' }, ownerTarget)
    await recovered.resolveApproval(grave.confirmationCode, 'approved', 'local-dashboard')
    await recovered.setDynamicBotStatus(grave.botId, 'deleted', 'user:feishu:ou_owner')
    await assert.rejects(recovered.validateStaticProfileHandles(['grave']), /墓碑|占用/u)

    await recovered.stop()
    recovered = undefined
    conflicted = new BotGateway({}, {
      ...config,
      profiles: { ...config.profiles, analyst: { title: 'Static Analyst' } },
    })
    await assert.rejects(conflicted.start(), /动态 Bot|墓碑|占用/u)
  } finally {
    if (initial) await initial.stop()
    if (recovered) await recovered.stop()
    if (conflicted) await conflicted.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('dynamic Bot namespace changes serialize with static reconfigure and roll back partial failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-namespace-transaction-'))
  const baseConfig = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
  }
  const ownerTarget = { platform: 'feishu', chatId: 'oc_owner', chatType: 'dm', userId: 'ou_owner' }
  let gateway
  try {
    gateway = new BotGateway({}, baseConfig)
    await gateway.start()

    const validateStaticProfiles = gateway.validateStaticProfileHandles.bind(gateway)
    let releaseValidation
    const validationReleased = new Promise(resolve => { releaseValidation = resolve })
    let validationReached
    const reachedValidation = new Promise(resolve => { validationReached = resolve })
    let pauseValidation = true
    gateway.validateStaticProfileHandles = async handles => {
      await validateStaticProfiles(handles)
      if (pauseValidation && handles.includes('racebot')) {
        pauseValidation = false
        validationReached()
        await validationReleased
      }
    }
    const staticReconfigure = gateway.reconfigure({
      ...baseConfig,
      profiles: { racebot: { title: 'Static Race Bot' } },
    })
    await reachedValidation
    const dynamicCreateAssertion = assert.rejects(
      gateway.createDynamicBotDraft({ handle: 'racebot', title: 'Dynamic Race Bot' }, ownerTarget),
      /静态配置占用/u,
    )
    releaseValidation()
    await Promise.all([staticReconfigure, dynamicCreateAssertion])
    gateway.validateStaticProfileHandles = validateStaticProfiles
    assert.equal(await gateway.registry.getByHandle('racebot'), undefined)
    assert.equal(gateway.directory.get('racebot')?.title, 'Static Race Bot')

    const loadFleetV2State = gateway.loadFleetV2State.bind(gateway)
    let injectApplyFailure = true
    gateway.loadFleetV2State = async () => {
      if (injectApplyFailure && gateway.directory.get('unstable') !== undefined) {
        injectApplyFailure = false
        throw new Error('controlled post-apply failure')
      }
      await loadFleetV2State()
    }
    await assert.rejects(gateway.reconfigure({
      ...baseConfig,
      profiles: {
        racebot: { title: 'Static Race Bot' },
        unstable: { title: 'Must Roll Back' },
      },
    }), /controlled post-apply failure/u)
    gateway.loadFleetV2State = loadFleetV2State
    assert.equal(gateway.directory.get('racebot')?.title, 'Static Race Bot')
    assert.equal(gateway.directory.get('unstable'), undefined)

    let persisted = false
    await assert.rejects(gateway.reconfigureAndCommit({
      ...baseConfig,
      profiles: {
        racebot: { title: 'Static Race Bot' },
        commitbot: { title: 'Commit Must Roll Back' },
      },
    }, async () => {
      persisted = true
      throw new Error('controlled settings persistence failure')
    }, async () => {
      persisted = false
    }), /controlled settings persistence failure/u)
    assert.equal(persisted, false)
    assert.equal(gateway.directory.get('commitbot'), undefined)
    assert.equal(gateway.directory.get('racebot')?.title, 'Static Race Bot')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('direct dynamic Agent lifecycle survives a transport-free plugin reload and prunes stale session history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-direct-agent-lifecycle-'))
  const agents = new Map()
  const agentRegistry = {
    get(id) { return agents.get(String(id)) },
    async resume() { throw new Error('not found') },
    async create() { throw new Error('not used') },
  }
  const target = { platform: 'feishu', chatId: 'oc_owner', chatType: 'dm', userId: 'ou_owner' }
  let gateway
  try {
    gateway = new BotGateway({ get: name => name === 'agents' ? agentRegistry : undefined }, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
    })
    const transport = { platform: 'feishu', async start() {}, async stop() {}, async send() {} }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const draft = await gateway.createDynamicBotDraft({ handle: 'livebot', title: 'Live Bot' }, target)
    await gateway.resolveApproval(draft.confirmationCode, 'approved', 'local-dashboard')
    const originalBinding = await gateway.bindingFor(target)
    const binding = await gateway.rotateBinding(target, originalBinding, 'livebot', null)
    let cancelCount = 0
    const inbox = { hasPending: false }
    const agent = {
      id: binding.sessionId,
      status: 'idle',
      inbox,
      options: {},
      followup() {
        inbox.hasPending = true
        this.status = 'running'
      },
      cancel() { cancelCount += 1 },
    }
    agents.set(binding.sessionId, agent)
    await gateway.rememberDirectProfileSession('livebot', binding.sessionId)
    await gateway.bridge.followup(agent, 'keep running')
    assert.equal(agent.status, 'running')
    assert.equal(inbox.hasPending, true)
    await gateway.rotateBinding(target, binding, 'default', null)

    await gateway.stop()
    gateway = new BotGateway({}, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
    })
    await gateway.start()
    assert.equal(gateway.bridge, undefined)
    await assert.rejects(
      gateway.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner'),
      /状态暂时无法确认/u,
    )
    const persistedWhileUnknown = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.deepEqual(persistedWhileUnknown.directProfileSessions.livebot, [binding.sessionId])
    await gateway.stop()

    gateway = new BotGateway({ get: name => name === 'agents' ? agentRegistry : undefined }, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
    })
    await gateway.start()
    assert.ok(gateway.bridge, 'Agent lifecycle bridge must initialize without an enabled transport')

    const persistedBefore = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.deepEqual(persistedBefore.directProfileSessions.livebot, [binding.sessionId])

    await assert.rejects(
      gateway.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner'),
      /对应会话发送 \/stop/u,
    )
    await assert.rejects(
      gateway.setDynamicBotStatus(draft.botId, 'deleted', 'user:feishu:ou_owner'),
      /对应会话发送 \/stop/u,
    )
    assert.equal((await gateway.registry.get(draft.botId))?.definition.status, 'active')
    assert.equal(cancelCount, 0)

    agent.status = 'idle'
    inbox.hasPending = false
    await gateway.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner')
    assert.equal((await gateway.registry.get(draft.botId))?.definition.status, 'disabled')
    assert.equal(cancelCount, 0)
    const persistedAfter = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.deepEqual(persistedAfter.directProfileSessions, {})
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('stop closes Bot mutation admission and drains lifecycle plus namespace tails before reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-stop-drain-'))
  const agents = new Map()
  const agentRegistry = {
    get(id) { return agents.get(String(id)) },
    async resume() { throw new Error('not found') },
    async create() { throw new Error('not used') },
  }
  const ctx = { get: name => name === 'agents' ? agentRegistry : undefined }
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
  }
  const firstTarget = { platform: 'feishu', chatId: 'oc_first', chatType: 'dm', userId: 'ou_owner' }
  const secondTarget = { platform: 'feishu', chatId: 'oc_second', chatType: 'dm', userId: 'ou_owner' }
  let gateway
  let reloaded
  let releasePersist
  let releaseCommit
  try {
    gateway = new BotGateway(ctx, config)
    const transport = { platform: 'feishu', async start() {}, async stop() {}, async send() {} }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const draft = await gateway.createDynamicBotDraft({ handle: 'drainbot', title: 'Drain Bot' }, firstTarget)
    await gateway.resolveApproval(draft.confirmationCode, 'approved', 'local-dashboard')
    const initial = await gateway.bindingFor(firstTarget)
    const direct = await gateway.rotateBinding(firstTarget, initial, 'drainbot', null)
    const agent = {
      id: direct.sessionId,
      status: 'idle',
      inbox: { hasPending: false },
      options: {},
      cancel() {},
    }
    agents.set(direct.sessionId, agent)
    await gateway.rememberDirectProfileSession('drainbot', direct.sessionId)

    const persistDirectProfileSessions = gateway.persistDirectProfileSessions.bind(gateway)
    const persistReleased = new Promise(resolve => { releasePersist = resolve })
    let persistReached
    const reachedPersist = new Promise(resolve => { persistReached = resolve })
    let blockPersist = true
    gateway.persistDirectProfileSessions = async () => {
      if (blockPersist) {
        blockPersist = false
        persistReached()
        await persistReleased
      }
      await persistDirectProfileSessions()
    }
    const disabling = gateway.setDynamicBotStatus(draft.botId, 'disabled', 'user:feishu:ou_owner')
    await reachedPersist
    const stopping = gateway.stop()
    assert.equal(await Promise.race([
      stopping.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    await assert.rejects(
      gateway.createDynamicBotDraft({ handle: 'latebot', title: 'Too Late' }, secondTarget),
      /Gateway is stopping/u,
    )
    releasePersist()
    await Promise.all([disabling, stopping])
    gateway = undefined

    reloaded = new BotGateway(ctx, config)
    await reloaded.start()
    const secondBinding = await reloaded.bindingFor(secondTarget)
    await new Promise(resolve => setImmediate(resolve))
    const stateAfterReload = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.ok(stateAfterReload.bindings[secondBinding.key], 'old instance overwrote the reloaded binding')

    const commitReleased = new Promise(resolve => { releaseCommit = resolve })
    let commitReached
    const reachedCommit = new Promise(resolve => { commitReached = resolve })
    const namespaceMutation = reloaded.reconfigureAndCommit(config, async () => {
      commitReached()
      await commitReleased
    })
    await reachedCommit
    const secondStop = reloaded.stop()
    assert.equal(await Promise.race([
      secondStop.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    await assert.rejects(reloaded.reconfigure(config), /Gateway is stopping/u)
    releaseCommit()
    await Promise.all([namespaceMutation, secondStop])
    reloaded = undefined
  } finally {
    if (gateway) {
      releasePersist?.()
      await gateway.stop()
    }
    if (reloaded) {
      releaseCommit?.()
      await reloaded.stop()
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('stop drains draft-update and approval leases before a replacement Gateway can observe durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-unified-mutation-drain-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
  }
  const target = { platform: 'feishu', chatId: 'oc_owner', chatType: 'dm', userId: 'ou_owner' }
  const actor = 'user:feishu:ou_owner'
  let gateway
  let reloaded
  let cold
  let releaseRevision
  let releaseApproval
  try {
    gateway = new BotGateway({}, config)
    await gateway.start()
    const draft = await gateway.createDynamicBotDraft({ handle: 'leasebot', title: 'Lease Bot v1' }, target)

    const revise = gateway.registry.revise.bind(gateway.registry)
    const revisionReleased = new Promise(resolve => { releaseRevision = resolve })
    let revisionReached
    const reachedRevision = new Promise(resolve => { revisionReached = resolve })
    gateway.registry.revise = async (...args) => {
      revisionReached()
      await revisionReleased
      return revise(...args)
    }
    const updating = gateway.updateDynamicBotDraft({ handle: 'leasebot', title: 'Lease Bot v2' }, target)
    await reachedRevision
    const stoppingAfterUpdate = gateway.stop()
    assert.equal(await Promise.race([
      stoppingAfterUpdate.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    await assert.rejects(
      gateway.updateDynamicBotDraft({ handle: 'leasebot', title: 'Too Late' }, target),
      /Gateway is stopping/u,
    )
    releaseRevision()
    const [updated] = await Promise.all([updating, stoppingAfterUpdate])
    gateway = undefined

    reloaded = new BotGateway({}, config)
    await reloaded.start()
    assert.equal((await reloaded.registry.get(draft.botId))?.definition.version, 2)
    assert.equal((await reloaded.registry.get(draft.botId))?.revision.title, 'Lease Bot v2')

    const resolveByCode = reloaded.approvals.resolveByCode.bind(reloaded.approvals)
    const approvalReleased = new Promise(resolve => { releaseApproval = resolve })
    let approvalReached
    const reachedApproval = new Promise(resolve => { approvalReached = resolve })
    reloaded.approvals.resolveByCode = async (...args) => {
      approvalReached()
      await approvalReleased
      return resolveByCode(...args)
    }
    const resolving = reloaded.resolveApproval(updated.confirmationCode, 'approved', actor)
    await reachedApproval
    const stoppingAfterApproval = reloaded.stop()
    assert.equal(await Promise.race([
      stoppingAfterApproval.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    await assert.rejects(
      reloaded.resolveApproval(updated.confirmationCode, 'approved', actor),
      /Gateway is stopping/u,
    )
    releaseApproval()
    await Promise.all([resolving, stoppingAfterApproval])
    reloaded = undefined

    cold = new BotGateway({}, config)
    await cold.start()
    assert.equal((await cold.registry.get(draft.botId))?.definition.status, 'active')
    assert.equal((await cold.registry.get(draft.botId))?.definition.version, 3)
    assert.equal((await cold.registry.get(draft.botId))?.revision.title, 'Lease Bot v2')
  } finally {
    releaseRevision?.()
    releaseApproval?.()
    if (gateway) await gateway.stop()
    if (reloaded) await reloaded.stop()
    if (cold) await cold.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('all durable public, model-tool, and Transport entrypoints reject admission after stop begins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-mutation-admission-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    collaboration: {
      features: {
        dynamicRegistry: true,
        chatBotCreation: true,
        managerAgent: true,
        savedWorkflows: true,
      },
    },
  }
  const target = { platform: 'feishu', chatId: 'oc_owner', chatType: 'dm', userId: 'ou_owner' }
  let inbound
  const agents = {
    get() { return undefined },
    async resume() { throw new Error('not found') },
    async create() { throw new Error('not used') },
  }
  const gateway = new BotGateway({ get: name => name === 'agents' ? agents : undefined }, config)
  const transport = {
    platform: 'feishu',
    async start(handler) { inbound = handler },
    async stop() {},
    async send() {},
  }
  gateway.transports = [transport]
  gateway.transportByPlatform.set('feishu', transport)
  try {
    await gateway.start()
    await gateway.stop()
    const attempts = [
      () => gateway.fleetStatus(),
      () => gateway.sendBotMessage({ from: 'tester', to: 'missing', instruction: 'x', replyTarget: target }),
      () => gateway.planManagerTask({ requester: 'tester', instruction: 'x', replyTarget: target }),
      () => gateway.createWorkflowDefinition({}),
      () => gateway.compileWorkflowDefinition({}),
      () => gateway.launchWorkflowDefinition('missing', 'tester', target),
      () => gateway.requestHandoff({ taskId: 'task', runId: 'run', fromBot: 'a', toBot: 'b', reason: 'x', requestedBy: 'tester', replyTarget: target }),
      () => gateway.createDynamicBotDraft({ handle: 'late', title: 'Late' }, target),
      () => gateway.setDynamicBotStatus('missing', 'disabled'),
      () => gateway.updateDynamicBotDraft({ handle: 'late', title: 'Later' }, target),
      () => gateway.resolveApproval('ABCDEFGH', 'approved'),
      () => gateway.cancelFleetTask('task'),
      () => gateway.replayFleetTask('task'),
      () => gateway.approvePairing('123456'),
      () => gateway.revokePairing('feishu', 'ou_owner'),
      () => gateway.reconfigure(config),
      () => gateway.reconfigureAndCommit(config, async () => {}),
      () => gateway.requestModelHandoff('missing-session', { toBot: 'b', reason: 'x' }),
      () => inbound({ id: 'late-inbound', target, text: 'late', receivedAt: Date.now() }),
    ]
    for (const attempt of attempts) await assert.rejects(attempt, /Gateway is stopping/u)
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('reconfigureAndCommit never commits a configuration that stop prevented from applying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-reconfigure-stop-'))
  const baseConfig = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
  }
  const gateway = new BotGateway({}, baseConfig)
  let releaseBoot
  let bootReached
  const reachedBoot = new Promise(resolve => { bootReached = resolve })
  const bootReleased = new Promise(resolve => { releaseBoot = resolve })
  const originalBoot = gateway.boot.bind(gateway)
  gateway.boot = async () => {
    bootReached()
    await bootReleased
    return originalBoot()
  }
  let namespaceChecks = 0
  let namespaceChecked
  const reachedNamespaceCheck = new Promise(resolve => { namespaceChecked = resolve })
  const originalNamespaceCheck = gateway.assertStaticProfileNamespace.bind(gateway)
  gateway.assertStaticProfileNamespace = async config => {
    await originalNamespaceCheck(config)
    namespaceChecks += 1
    if (namespaceChecks === 1) namespaceChecked()
  }
  let commitCalls = 0
  try {
    const starting = gateway.start()
    await reachedBoot
    const reconfiguring = gateway.reconfigureAndCommit({
      ...baseConfig,
      profiles: { commitbot: { title: 'Must not be committed' } },
    }, async () => { commitCalls += 1 })
    await reachedNamespaceCheck
    await new Promise(resolve => setImmediate(resolve))
    const stopping = gateway.stop()
    releaseBoot()

    await starting
    await assert.rejects(reconfiguring, /stopped before the configuration could be applied/u)
    await stopping
    assert.equal(commitCalls, 0)
    assert.equal(gateway.directory.get('commitbot'), undefined)
    assert.equal('commitbot' in (gateway.config.profiles ?? {}), false)
  } finally {
    releaseBoot?.()
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('stop drains an already-entered Mailbox heartbeat and prevents it from rescheduling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-heartbeat-drain-'))
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    profiles: { researcher: { capabilities: ['research'] } },
    collaboration: { enabled: true, mailboxLeaseMs: 30_000 },
  }
  let gateway
  let fresh
  let releaseRenew
  const originalSetTimeout = globalThis.setTimeout
  try {
    gateway = new BotGateway({}, config)
    await gateway.start()
    const task = await gateway.tasks.createTask({
      title: 'heartbeat', instruction: 'hold the lease', createdBy: 'tester', assignedTo: 'researcher',
    })
    const run = await gateway.tasks.createRun(task.id, 'researcher', 1)
    const envelope = createEnvelope({
      from: 'tester', to: 'researcher', taskId: task.id, runId: run.id,
      attemptId: run.attemptId, correlationId: task.id, payload: { instruction: task.instruction },
    })
    await gateway.mailbox.enqueue(envelope, `heartbeat:${run.id}`)
    const claimed = await gateway.mailbox.claim(['researcher'], 'heartbeat-worker')
    assert.ok(claimed)
    const acknowledged = await gateway.mailbox.acknowledge(claimed)
    assert.ok(acknowledged)
    const running = await gateway.mailbox.start({ ...claimed, item: acknowledged })
    assert.ok(running)
    const internal = {
      runId: run.id,
      botId: 'researcher',
      sessionId: 'heartbeat-session',
      lease: { ...claimed, item: running },
      envelope,
      texts: [],
    }
    gateway.internalRuns.set(run.id, internal)

    const renew = gateway.mailbox.renew.bind(gateway.mailbox)
    const renewReleased = new Promise(resolve => { releaseRenew = resolve })
    let renewReached
    const reachedRenew = new Promise(resolve => { renewReached = resolve })
    gateway.mailbox.renew = async (...args) => {
      renewReached()
      await renewReleased
      return renew(...args)
    }

    let heartbeatCallback
    let scheduledHeartbeats = 0
    globalThis.setTimeout = callback => {
      scheduledHeartbeats += 1
      heartbeatCallback = callback
      return { unref() {} }
    }
    gateway.scheduleLeaseHeartbeat(internal)
    globalThis.setTimeout = originalSetTimeout
    assert.equal(typeof heartbeatCallback, 'function')
    heartbeatCallback()
    await reachedRenew

    const stopping = gateway.stop()
    assert.equal(await Promise.race([
      stopping.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    gateway.scheduleLeaseHeartbeat(internal)
    assert.equal(scheduledHeartbeats, 1, 'stop admitted a new heartbeat timer')
    releaseRenew()
    await stopping

    const oldItem = await gateway.mailbox.get(envelope.id)
    fresh = new BotGateway({}, config)
    await fresh.start()
    const freshItem = await fresh.mailbox.get(envelope.id)
    const coldMailbox = new BotMailbox(join(root, 'mailbox.jsonl'), config.collaboration)
    const coldItem = await coldMailbox.get(envelope.id)
    for (const item of [oldItem, freshItem, coldItem]) {
      assert.equal(item?.state, 'running')
      assert.equal(item?.fencingToken, oldItem?.fencingToken)
      assert.equal(item?.leaseExpiresAt, oldItem?.leaseExpiresAt)
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout
    releaseRenew?.()
    if (gateway) await gateway.stop()
    if (fresh) await fresh.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the same Gateway fences and reclaims an active Run across stop and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-active-run-restart-'))
  const agents = new Map()
  let followupCalls = 0
  let cancelCalls = 0
  let cancelledTurnEnd
  const makeAgent = sessionId => {
    const events = []
    const session = {
      get events() { return events },
      get seq() { return events.length },
      append(type, data) {
        const event = { type, seq: events.length, time: Date.now(), data }
        events.push(event)
        return event
      },
    }
    const agent = {
      id: String(sessionId),
      session,
      status: 'idle',
      inbox: { hasPending: false },
      followup() {
        followupCalls += 1
        const latestTurn = events.reduce((latest, event) => Math.max(latest, Number(event.data?.turn ?? 0)), 0)
        session.append('turn/start', { turn: latestTurn + 1 })
        agent.status = 'running'
      },
      cancel() {
        cancelCalls += 1
        const latestTurn = events.reduce((latest, event) => Math.max(latest, Number(event.data?.turn ?? 0)), 0)
        if (agent.status === 'running') {
          cancelledTurnEnd = session.append('turn/end', { turn: latestTurn, reason: { kind: 'aborted' } })
        }
        agent.status = 'idle'
      },
      async whenIdle() {},
    }
    agents.set(String(sessionId), agent)
    return agent
  }
  const registry = {
    get(sessionId) { return agents.get(String(sessionId)) },
    async resume() { throw new Error('not found') },
    async create({ sessionId }) { return { agent: makeAgent(sessionId) } },
  }
  const config = {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
    profiles: { researcher: { capabilities: ['research'] } },
    collaboration: { enabled: true, mailboxLeaseMs: 30_000 },
  }
  const gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, config)
  const makeTransport = () => ({
    platform: 'feishu', async start() {}, async stop() {}, async send() {},
  })
  const install = () => {
    const transport = makeTransport()
    gateway.transports = [transport]
    gateway.transportByPlatform.clear()
    gateway.transportByPlatform.set('feishu', transport)
  }
  try {
    install()
    gateway.installTransports = install
    await gateway.start()

    const task = await gateway.tasks.createTask({
      title: 'restart active run', instruction: 'continue after restart', createdBy: 'tester', assignedTo: 'researcher',
    })
    const run = await gateway.tasks.createRun(task.id, 'researcher', 1)
    await gateway.tasks.startRun(run.id)
    const envelope = createEnvelope({
      from: 'tester', to: 'researcher', taskId: task.id, runId: run.id,
      attemptId: run.attemptId, correlationId: task.id, payload: { instruction: task.instruction },
    })
    await gateway.mailbox.enqueue(envelope, `restart:${run.id}`)
    const claimed = await gateway.mailbox.claim(['researcher'], gateway.collaborationWorkerId)
    assert.ok(claimed)
    const acknowledged = await gateway.mailbox.acknowledge(claimed)
    assert.ok(acknowledged)
    const running = await gateway.mailbox.start({ ...claimed, item: acknowledged })
    assert.ok(running)
    const oldLease = { ...claimed, item: running }
    const oldSessionId = gateway.directory.sessionIdFor('researcher', {
      requester: 'tester',
      target: { platform: 'internal', chatId: task.id },
      taskId: task.id,
    })
    assert.ok(oldSessionId)
    const oldAgent = makeAgent(oldSessionId)
    oldAgent.session.append('turn/start', { turn: 1 })
    const staleAssistant = oldAgent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'STALE_OLD_TURN_RESULT' }] },
    })
    oldAgent.status = 'running'
    const internal = {
      runId: run.id,
      botId: 'researcher',
      sessionId: oldSessionId,
      lease: oldLease,
      envelope,
      texts: [],
    }
    gateway.internalRuns.set(run.id, internal)
    gateway.internalRunBySession.set(oldSessionId, run.id)
    gateway.activeBotRuns.set('researcher', run.id)

    await gateway.stop()
    const released = await gateway.mailbox.get(envelope.id)
    assert.equal(released?.state, 'queued')
    assert.equal(released?.fencingToken, oldLease.fencingToken + 1)
    assert.equal('leaseId' in released, false)
    assert.equal(await gateway.mailbox.complete(oldLease), undefined)
    assert.equal(gateway.internalRuns.size, 0)
    assert.equal(gateway.internalRunBySession.size, 0)
    assert.equal(gateway.activeBotRuns.size, 0)

    await gateway.start()
    await gateway.drainCollaboration()
    const reclaimed = await gateway.mailbox.get(envelope.id)
    assert.equal(reclaimed?.state, 'running')
    assert.ok(reclaimed.fencingToken > released.fencingToken)
    assert.equal(gateway.internalRuns.has(run.id), true)
    assert.equal(gateway.activeBotRuns.get('researcher'), run.id)
    assert.equal(followupCalls, 1)
    assert.ok(cancelCalls >= 1)
    const restartedInternal = gateway.internalRuns.get(run.id)
    assert.equal(restartedInternal?.sessionId, oldSessionId)
    assert.equal(restartedInternal?.expectedTurn, 2)
    assert.ok(cancelledTurnEnd)

    gateway.onSessionEvent(oldAgent, staleAssistant)
    gateway.onSessionEvent(oldAgent, cancelledTurnEnd)
    gateway.onSessionEvent(oldAgent, {
      ...cancelledTurnEnd,
      seq: cancelledTurnEnd.seq + 100,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    gateway.onSessionEvent(oldAgent, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'MISSING_EVENT_IDENTITY' }] } },
    })
    gateway.onSessionEvent(oldAgent, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await Promise.all([...gateway.sessionEventTasks])
    assert.equal((await gateway.mailbox.get(envelope.id))?.state, 'running')
    assert.equal((await gateway.tasks.run(run.id))?.status, 'running')
    assert.equal((await gateway.tasks.task(task.id))?.status, 'running')
    assert.deepEqual(restartedInternal?.texts, [])
    const staleAudits = (await gateway.tasks.snapshot()).audits.filter(audit => (
      audit.action === 'message.stale_session_event' && audit.data?.runId === run.id
    ))
    assert.equal(staleAudits.length, 5)

    const freshAssistant = oldAgent.session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: 'FRESH_NEW_TURN_RESULT' }] },
    })
    const freshEnd = oldAgent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    oldAgent.status = 'idle'
    gateway.onSessionEvent(oldAgent, freshAssistant)
    gateway.onSessionEvent(oldAgent, freshEnd)
    await Promise.all([...gateway.sessionEventTasks])
    assert.equal((await gateway.mailbox.get(envelope.id))?.state, 'completed')
    assert.equal((await gateway.tasks.run(run.id))?.status, 'completed')
    assert.equal((await gateway.tasks.task(task.id))?.result, 'FRESH_NEW_TURN_RESULT')
    assert.equal(gateway.internalRuns.size, 0)
  } finally {
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the same Gateway reinstalls exactly one Transport after concurrent stop and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-transport-restart-'))
  const agents = {
    get() { return undefined },
    async resume() { throw new Error('not found') },
    async create() { throw new Error('not used') },
  }
  const gateway = new BotGateway({ get: name => name === 'agents' ? agents : undefined }, {
    stateDir: root,
    telegram: { enabled: false }, feishu: { enabled: false },
  })
  let startCalls = 0
  let stopCalls = 0
  let installCalls = 0
  let releaseFirstStop
  let firstStopReached
  const reachedFirstStop = new Promise(resolve => { firstStopReached = resolve })
  const firstStopReleased = new Promise(resolve => { releaseFirstStop = resolve })
  const makeTransport = (blockStop = false) => ({
    platform: 'feishu',
    async start() { startCalls += 1 },
    async stop() {
      stopCalls += 1
      if (blockStop) {
        firstStopReached()
        await firstStopReleased
      }
    },
    async send() {},
  })
  const install = () => {
    installCalls += 1
    const transport = makeTransport(false)
    gateway.transports = [transport]
    gateway.transportByPlatform.clear()
    gateway.transportByPlatform.set('feishu', transport)
  }
  try {
    const firstTransport = makeTransport(true)
    gateway.transports = [firstTransport]
    gateway.transportByPlatform.set('feishu', firstTransport)
    gateway.installTransports = install
    await gateway.start()
    assert.equal(startCalls, 1)

    const stopping = gateway.stop()
    await reachedFirstStop
    const restarting = gateway.start()
    assert.equal(await Promise.race([
      restarting.then(() => 'settled'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'pending')
    releaseFirstStop()
    await Promise.all([stopping, restarting])
    assert.equal(gateway.running, true)
    assert.equal(gateway.transports.length, 1)
    assert.equal(installCalls, 1)
    assert.equal(startCalls, 2)
    assert.equal(stopCalls, 1)

    await gateway.start()
    assert.equal(startCalls, 2, 'start while already running duplicated the Transport')
    await gateway.stop()
    assert.equal(stopCalls, 2)
    await gateway.start()
    assert.equal(installCalls, 2)
    assert.equal(startCalls, 3)
    assert.equal(gateway.transports.length, 1)
  } finally {
    releaseFirstStop?.()
    await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('chat commands create, confirm, edit, isolate, disable, enable, and delete a dynamic Bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-dynamic-commands-'))
  let gateway
  try {
    const agents = {
      get() { return undefined },
      async resume() { throw new Error('not found') },
      async create() { throw new Error('commands should not create an Agent') },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agents : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a', 'ou_b'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true } },
    })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const send = async (id, userId, text) => {
      const before = sent.length
      await inbound({
        id,
        target: { platform: 'feishu', chatId: `oc_${userId}`, chatType: 'dm', userId },
        text,
        receivedAt: Date.now(),
      })
      const deadline = Date.now() + 2_000
      while (sent.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.ok(sent.length > before, `no reply for ${text}`)
      return sent.at(-1).text
    }

    const created = await send('dynamic-create', 'ou_a', '/bot create analyst 数据分析师')
    const code = /\/bot confirm ([A-Z0-9]{8})/u.exec(created)?.[1]
    assert.ok(code)
    assert.match(await send('dynamic-wrong-confirm', 'ou_b', `/bot confirm ${code}`), /不属于当前用户/u)
    assert.equal((await gateway.registry.getByHandle('analyst'))?.definition.status, 'draft')
    assert.match(await send('dynamic-confirm', 'ou_a', `/bot confirm ${code}`), /已确认并激活 @analyst/u)
    assert.match(await send('dynamic-owner-roster', 'ou_a', '/bots'), /@analyst/u)
    assert.doesNotMatch(await send('dynamic-other-roster', 'ou_b', '/bots'), /@analyst/u)
    assert.match(await send('dynamic-other-switch', 'ou_b', '/bot analyst'), /没有使用 @analyst 的权限/u)
    assert.match(await send('dynamic-edit', 'ou_a', '/bot edit analyst title 高级数据分析师'), /已更新 @analyst/u)
    assert.equal((await gateway.registry.getByHandle('analyst'))?.revision.title, '高级数据分析师')
    assert.match(await send('dynamic-disable', 'ou_a', '/bot disable analyst'), /已停用 @analyst/u)
    assert.equal(gateway.directory.get('analyst'), undefined)
    assert.match(await send('dynamic-enable', 'ou_a', '/bot enable analyst'), /已重新启用 @analyst/u)
    assert.ok(gateway.directory.get('analyst'))
    assert.match(await send('dynamic-delete-warning', 'ou_a', '/bot delete analyst'), /确定后发送/u)
    assert.match(await send('dynamic-delete', 'ou_a', '/bot delete analyst confirm'), /已删除 @analyst/u)
    assert.equal((await gateway.registry.getByHandle('analyst'))?.definition.status, 'deleted')
    assert.equal(gateway.directory.get('analyst'), undefined)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Feishu session does NOT receive bot_create_draft even with dynamicRegistry ON - tools are DSH Web only', async () => {
  // CRO requirement: bot creation tools (bot_create_draft, bot_update_draft) are ONLY installed
  // on local DSH web sessions. Feishu/Telegram sessions NEVER receive these tools.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-feishu-no-tools-'))
  let gateway
  try {
    const agents = new Map()
    const registeredTools = new Map()
    const agentRegistry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, agentOptions, setup }) {
        const runtime = { register(tool) { registeredTools.set(tool.name, tool); return () => {} } }
        const agentCtx = { get(name) { return name === 'tools' ? runtime : undefined } }
        if (setup) await setup(agentCtx)
        const liveAgent = {
          id: String(sessionId), ctx: agentCtx, status: 'idle', options: agentOptions ?? {}, cancel() {}, followup() {},
        }
        agents.set(String(sessionId), liveAgent)
        return { agent: liveAgent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agentRegistry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_tool'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      // Both flags ON - but Feishu should still NOT get the tools
      collaboration: { features: { dynamicRegistry: true, chatBotCreation: true, webChatBotCreation: true } },
    })
    let inbound
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {}, async send() {},
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    await inbound({
      id: 'feishu-tool-message',
      target: { platform: 'feishu', chatId: 'oc_tool', chatType: 'dm', userId: 'ou_tool' },
      text: '帮我创建一个专门做研究的 Bot',
      receivedAt: Date.now(),
    })
    // Wait a bit to ensure any async tool registration would have happened
    await new Promise(resolve => setTimeout(resolve, 500))
    // Feishu sessions should NOT receive the bot creation tools
    assert.equal(registeredTools.has('bot_create_draft'), false, 'Feishu session should NOT receive bot_create_draft')
    assert.equal(registeredTools.has('bot_update_draft'), false, 'Feishu session should NOT receive bot_update_draft')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('chat Team commands keep membership explicit and owner-scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-team-command-'))
  let gateway
  try {
    const agents = {
      get() { return undefined },
      async resume() { throw new Error('not found') },
      async create() { throw new Error('Team commands should not create an Agent') },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agents : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a', 'ou_b'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { capabilities: ['research'] },
        reviewer: { capabilities: ['review'] },
      },
      collaboration: { enabled: true, approvalMode: 'never' },
    })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu',
      async start(handler) { inbound = handler },
      async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const send = async (id, userId, text) => {
      const before = sent.length
      await inbound({
        id,
        target: { platform: 'feishu', chatId: `oc_${userId}`, chatType: 'dm', userId },
        text,
        receivedAt: Date.now(),
      })
      const deadline = Date.now() + 2_000
      while (sent.length <= before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      return sent[sent.length - 1]?.text ?? ''
    }
    const created = await send('team-create', 'ou_a', '/team create Research researcher')
    assert.match(created, /Team 已创建：/u)
    const teamId = created.match(/Team 已创建：([0-9a-f-]{36})/u)?.[1]
    assert.ok(teamId)
    assert.match(await send('team-add', 'ou_a', `/team add ${teamId} reviewer`), /显式加入 Team/u)
    const status = await send('team-status', 'ou_a', `/team status ${teamId}`)
    assert.match(status, /@researcher/u)
    assert.match(status, /@reviewer/u)
    assert.match(await send('team-manager', 'ou_a', `/team manager ${teamId} reviewer`), /Team Manager 已更新/u)
    assert.match(await send('team-remove', 'ou_a', `/team remove ${teamId} researcher`), /显式移出 Team/u)
    assert.doesNotMatch(await send('team-owner-privacy', 'ou_b', '/teams'), new RegExp(teamId, 'u'))
    assert.doesNotMatch(await send('team-owner-privacy-name', 'ou_b', '/teams'), /Research/u)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('@team creates a durable Team Thread and bounded Group Room from chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-gateway-team-router-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, agentOptions }) {
        const agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() {},
          followup() {},
        })
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? registry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_team'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      profiles: {
        researcher: { capabilities: ['research'], allowedUserIds: ['ou_team'] },
        reviewer: { capabilities: ['review'], allowedUserIds: ['ou_team'] },
      },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        maxGroupRounds: 1,
        maxGroupMessages: 10,
      },
    })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu',
      async start(handler) { inbound = handler },
      async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    const requester = 'user:feishu:ou_team'
    const team = await gateway.teams.createTeam({
      name: 'Research Team',
      scope: 'user',
      ownerId: requester,
      memberBotIds: ['researcher', 'reviewer'],
      managerBotId: 'reviewer',
    }, requester)
    await inbound({
      id: 'team-router-message',
      target: { platform: 'feishu', chatId: 'oc_team', chatType: 'dm', userId: 'ou_team' },
      text: `@team:${team.id} 请研究并复核`,
      receivedAt: Date.now(),
    })
    const deadline = Date.now() + 2_000
    while (!sent.some(item => /已创建 Team Research Team 协作 Thread\/Room/u.test(item.text)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(sent.some(item => /已创建 Team Research Team 协作 Thread\/Room/u.test(item.text)))
    const threads = await gateway.teams.listThreads(team.id)
    assert.equal(threads.length, 1)
    assert.equal(threads[0]?.status, 'open')
    assert.deepEqual(threads[0]?.participantBotIds, ['reviewer', 'researcher'])
    const snapshot = await gateway.fleetStatus()
    assert.equal(snapshot.fleet.tasks.length, 1)
    assert.equal(snapshot.fleet.rooms.length, 1)
    assert.ok(snapshot.fleet.mailbox.queued + snapshot.fleet.mailbox.claimed + snapshot.fleet.mailbox.acknowledged + snapshot.fleet.mailbox.running >= 1)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('unbound local DSH web session can create+confirm bot into roster via API with only webChatBotCreation ON', async () => {
  // BLOCKER TEST: DSH web sessions (platform=local, unbound) MUST be able to create/confirm bots
  // with only webChatBotCreation ON. This test uses the API directly to verify the core functionality.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-local-web-api-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      access: { userIds: [] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false, // CRO requirement: keep OFF
          chatBotCreation: false,
          webChatBotCreation: true, // ONLY this flag is ON
        },
      },
    })
    await gateway.start()
    // Create a bot with local target (unbound DSH web session) via API
    const localTarget = { platform: 'local', chatId: 'local-dashboard', chatType: 'dm', userId: 'local-owner' }
    const botDraft = await gateway.createDynamicBotDraft({
      handle: 'local-research-bot',
      title: 'Bot from Local DSH Web Session',
      role: 'worker',
      capabilities: ['research'],
    }, localTarget)
    assert.equal(botDraft.status, 'draft')
    assert.ok(botDraft.confirmationCode, 'Should have a confirmation code')
    assert.match(botDraft.confirmationCode, /^[A-Z0-9]{8}$/u)
    // Confirm the bot - user:local:* actors are recognized as local owners
    await gateway.resolveApproval(botDraft.confirmationCode, 'approved', 'user:local:local-owner')
    // Verify the bot is in the roster
    const botEntry = gateway.directory.get('local-research-bot')
    assert.ok(botEntry, 'Bot should be in the roster after confirmation')
    assert.equal(botEntry.enabled, true)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Feishu actors cannot use resolveApproval to activate bots - only DSH Web local-dashboard can', async () => {
  // CRO requirement: resolveApproval must NOT be a backdoor for Feishu actors
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-feishu-backdoor-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      access: { userIds: ['ou_a'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false,
          chatBotCreation: false,
          webChatBotCreation: true,
        },
      },
    })
    await gateway.start()
    // Create bot via local target
    const botDraft = await gateway.createDynamicBotDraft({
      handle: 'test-bot',
      title: 'Test Bot',
    }, { platform: 'local', chatId: 'local-dashboard', chatType: 'dm', userId: 'local-owner' })
    // Feishu actor should be BLOCKED from approving
    await assert.rejects(
      gateway.resolveApproval(botDraft.confirmationCode, 'approved', 'user:feishu:ou_a'),
      /DSH Web/u,
      'Feishu actor should not be able to use resolveApproval'
    )
    // local-dashboard CAN approve
    const approval = await gateway.resolveApproval(botDraft.confirmationCode, 'approved', 'local-dashboard')
    assert.equal(approval?.status, 'approved')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Feishu /bot commands are blocked when dynamicRegistry is OFF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-feishu-blocked-'))
  let gateway
  try {
    const agents = {
      get() { return undefined },
      async resume() { throw new Error('not found') },
      async create() { throw new Error('should not create agent') },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agents : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_a'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false, // OFF
          chatBotCreation: false,
          webChatBotCreation: true,
        },
      },
    })
    const sent = []
    let inbound
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {},
      async send(target, text) { sent.push({ target, text }) },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    await inbound({
      id: 'blocked-create',
      target: { platform: 'feishu', chatId: 'oc_a', chatType: 'dm', userId: 'ou_a' },
      text: '/bot create test-bot',
      receivedAt: Date.now(),
    })
    const deadline = Date.now() + 2_000
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(sent.some(item => /飞书.*Telegram.*尚未启用|DSH Web/u.test(item.text)), 'Feishu /bot create should be blocked')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('dynamically created bot joins roster only and does NOT auto-expand into Teams', async () => {
  // CRO requirement: new bots join roster only, must NOT auto-add to Teams.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-no-team-expand-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      access: { userIds: ['ou_owner'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false,
          chatBotCreation: false,
          webChatBotCreation: true,
        },
      },
    })
    await gateway.start()
    // Create a Team first with just the default bot
    const team = await gateway.teams.createTeam({
      name: 'Test Team',
      scope: 'user',
      ownerId: 'user:local:ou_owner',
      memberBotIds: ['default'],
      managerBotId: 'default',
    }, 'user:local:ou_owner')
    // Get the team and verify it was created correctly
    const teamBefore = await gateway.teams.getTeam(team.id)
    assert.ok(teamBefore, 'Team should exist')
    assert.deepEqual([...teamBefore.memberBotIds], ['default'], 'Team should start with only default bot')
    // Create and confirm a new bot from local DSH web
    const localTarget = { platform: 'local', chatId: 'local-dashboard', chatType: 'dm', userId: 'ou_owner' }
    const botDraft = await gateway.createDynamicBotDraft({
      handle: 'new-bot',
      title: 'Newly Created Bot',
      role: 'worker',
    }, localTarget)
    await gateway.resolveApproval(botDraft.confirmationCode, 'approved', 'local-dashboard')
    // Verify the bot is in the roster
    const botEntry = gateway.directory.get('new-bot')
    assert.ok(botEntry, 'New bot should be in the roster')
    assert.equal(botEntry.enabled, true, 'New bot should be enabled')
    // Verify the Team did NOT auto-expand to include the new bot
    const teamAfter = await gateway.teams.getTeam(team.id)
    assert.ok(teamAfter, 'Team should still exist')
    assert.deepEqual([...teamAfter.memberBotIds], ['default'], 'Team should NOT auto-expand to include new bot')
    assert.equal(teamAfter.memberBotIds.includes('new-bot'), false, 'New bot should NOT be auto-added to Team')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('webChatBotCreation=true with Feishu-bound session does NOT receive bot_create_draft and cannot create via tool', async () => {
  // CRO explicit requirement: Feishu-bound sessions must NOT receive bot creation tools
  // even when webChatBotCreation is true.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-feishu-bound-no-tools-'))
  let gateway
  try {
    const agents = new Map()
    const registeredTools = new Map()
    const agentRegistry = {
      get(id) { return agents.get(String(id)) },
      async resume() { throw new Error('not found') },
      async create({ sessionId, agentOptions, setup }) {
        const runtime = { register(tool) { registeredTools.set(tool.name, tool); return () => {} } }
        const agentCtx = { get(name) { return name === 'tools' ? runtime : undefined } }
        if (setup) await setup(agentCtx)
        const liveAgent = {
          id: String(sessionId), ctx: agentCtx, status: 'idle', options: agentOptions ?? {}, cancel() {}, followup() {},
        }
        agents.set(String(sessionId), liveAgent)
        return { agent: liveAgent }
      },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agentRegistry : undefined }, {
      stateDir: root,
      access: { userIds: ['ou_feishu_user'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false, // OFF - CRO requirement
          chatBotCreation: false,
          webChatBotCreation: true, // ON - but Feishu should NOT get tools
        },
      },
    })
    let inbound
    const transport = {
      platform: 'feishu', async start(handler) { inbound = handler }, async stop() {}, async send() {},
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    // Send message from Feishu-bound session
    await inbound({
      id: 'feishu-bound-message',
      target: { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_feishu_user' },
      text: '帮我创建一个 Bot',
      receivedAt: Date.now(),
    })
    // Wait to ensure any async tool registration would have happened
    await new Promise(resolve => setTimeout(resolve, 500))
    // Feishu-bound sessions should NOT receive the bot creation tools
    assert.equal(registeredTools.has('bot_create_draft'), false, 'Feishu-bound session should NOT receive bot_create_draft')
    assert.equal(registeredTools.has('bot_update_draft'), false, 'Feishu-bound session should NOT receive bot_update_draft')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('createBotDraftFromSession rejects Feishu-bound session even when webChatBotCreation is ON', async () => {
  // CRO requirement: createBotDraftFromSession must REFUSE Feishu/Telegram targets.
  // Even if tools are somehow installed, the session methods must throw.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-create-tool-rejects-feishu-'))
  let gateway
  try {
    gateway = new BotGateway({}, {
      stateDir: root,
      access: { userIds: ['ou_feishu_user'] },
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false,
          chatBotCreation: false,
          webChatBotCreation: true,
        },
      },
    })
    await gateway.start()
    // Simulate a Feishu-bound session by registering a target
    const feishuTarget = { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_feishu_user' }
    const sessionId = 'test-feishu-session'
    await gateway.rememberSessionTarget(sessionId, feishuTarget)
    // Directly call the tool handler with the Feishu-bound session
    // This should throw because Feishu targets are not allowed
    await assert.rejects(
      gateway.botCreateDraftTool.execute({
        handle: 'feishu-bot', title: 'Feishu Bot',
      }, {
        signal: new AbortController().signal,
        agent: { id: sessionId, session: { id: sessionId, events: [], seq: 0 } },
        concludeTurn() {},
        deferContext() {},
      }),
      /飞书|Telegram|DSH Web/u,
      'createBotDraftFromSession should reject Feishu-bound sessions'
    )
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('native DSH web user agent receives bot_create_draft tools via owner session registration hook', async () => {
  // Production path: index.ts calls tryRegisterOwnerWebSession on turn/start.
  const root = await mkdtemp(join(tmpdir(), 'deepseek-native-web-tools-'))
  let gateway
  try {
    const agents = new Map()
    const registeredTools = new Map()
    const agentRegistry = {
      get(id) {
        const sessionKey = String(id)
        const existing = agents.get(sessionKey)
        if (existing) return existing
        const runtime = { register(tool) { registeredTools.set(tool.name, tool); return () => {} } }
        const agentCtx = { get(name) { return name === 'tools' ? runtime : undefined } }
        const nativeAgent = {
          id: sessionKey, ctx: agentCtx, status: 'idle', options: {}, cancel() {}, followup() {},
          session: { id: sessionKey, events: [], seq: 0 },
        }
        agents.set(sessionKey, nativeAgent)
        return nativeAgent
      },
      async resume() { throw new Error('not found') },
      async create() { throw new Error('native sessions should not call create') },
    }
    gateway = new BotGateway({ get: name => name === 'agents' ? agentRegistry : undefined }, {
      stateDir: root,
      telegram: { enabled: false }, feishu: { enabled: false },
      collaboration: {
        features: {
          dynamicRegistry: false,
          chatBotCreation: false,
          webChatBotCreation: true,
        },
      },
    })
    await gateway.start()
    const sessionId = 'native-web-session-12345'
    const session = { id: sessionId, events: [], seq: 0 }
    gateway.tryRegisterOwnerWebSession(session, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(registeredTools.has('bot_create_draft'), 'Native DSH web session should receive bot_create_draft tool')
    assert.ok(registeredTools.has('bot_update_draft'), 'Native DSH web session should receive bot_update_draft tool')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
