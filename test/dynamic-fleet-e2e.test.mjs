import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { emitMockAgentEvent, withMockSession } from './mock-agent.mjs'

const ownerTarget = {
  platform: 'feishu',
  chatId: 'oc_dynamic_owner',
  chatType: 'dm',
  userId: 'ou_dynamic_owner',
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function dynamicFleetConfig(stateDir) {
  return {
    stateDir,
    access: { userIds: ['ou_dynamic_owner', 'ou_other'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      reviewer: {
        capabilities: ['review'],
        fleetRole: 'verifier',
        allowedUserIds: ['ou_dynamic_owner'],
      },
    },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      managerBotId: 'manager',
      autoPlanner: true,
      features: {
        dynamicRegistry: true,
        chatBotCreation: true,
        peerMessaging: true,
        managerAgent: true,
        savedWorkflows: true,
      },
    },
  }
}

function workflowDraft() {
  return {
    name: 'Dynamic analyst workflow',
    description: 'Use the dynamically created analyst Bot',
    ownerId: 'user:feishu:ou_dynamic_owner',
    scope: 'user',
    entryNodeId: 'analyze',
    inputs: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'analyze', output: 'result' } }],
    nodes: [{
      id: 'analyze',
      label: 'Analyze the topic',
      kind: 'task',
      capability: 'analysis',
      inputs: [{ name: 'topic', source: { kind: 'input', name: 'topic' } }],
      outputs: ['result'],
      messageBudget: 2,
      tokenBudget: 1_000,
      costUnits: 10,
    }],
    edges: [],
    policy: {
      budget: {
        maxDepth: 2,
        maxParallel: 1,
        maxFanOut: 1,
        maxMessages: 4,
        maxTokens: 4_000,
        maxCostUnits: 40,
      },
      allowedCapabilities: ['analysis'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
}

test('chat-created Bot automatically joins the authorized Fleet and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-dynamic-fleet-e2e-'))
  const agents = new Map()
  const prompts = []
  const sent = []
  let inbound
  let activeGateway
  let gateway
  let restarted
  try {
    const agentRegistry = {
      get(id) { return agents.get(String(id)) },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions, meta }) {
        const preset = meta?.agentPreset ?? 'unknown'
        let agent
        agent = withMockSession({
          id: String(sessionId),
          status: 'idle',
          options: agentOptions ?? {},
          cancel() { agent.status = 'idle' },
          followup(prompt) {
            const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
            prompts.push({ preset, prompt: promptText })
            setTimeout(() => {
              const result = preset === 'analyst' && promptText.includes('peer-chain')
                ? '@reviewer please verify the analyst report'
                : `${preset}-result`
              emitMockAgentEvent(activeGateway, agent, 'assistant/message', {
                message: { content: [{ type: 'text', text: result }] },
              })
              emitMockAgentEvent(activeGateway, agent, 'turn/end', { reason: { kind: 'completed' } })
            }, 0)
          },
        })
        agents.set(String(sessionId), agent)
        return { agent }
      },
    }
    const context = { get: name => name === 'agents' ? agentRegistry : undefined }
    const attachTransport = instance => {
      const transport = {
        platform: 'feishu',
        async start(handler) { inbound = handler },
        async stop() {},
        async send(target, text) { sent.push({ target, text }) },
      }
      instance.transports = [transport]
      instance.transportByPlatform.set('feishu', transport)
    }
    const send = async (id, text, target = ownerTarget) => {
      const before = sent.length
      await inbound({ id, target, text, receivedAt: Date.now() })
      await waitUntil(() => sent.length > before, `no reply for ${text}`)
      return sent.at(-1).text
    }

    gateway = new BotGateway(context, dynamicFleetConfig(root))
    activeGateway = gateway
    attachTransport(gateway)
    await gateway.start()

    const created = await send('dynamic-e2e-create', '/bot create analyst 数据分析师')
    const originalCode = /\/bot confirm ([A-Z0-9]{8})/u.exec(created)?.[1]
    assert.ok(originalCode)
    const edited = await send('dynamic-e2e-capability', '/bot edit analyst capabilities analysis,research')
    const code = /\/bot confirm ([A-Z0-9]{8})/u.exec(edited)?.[1]
    assert.ok(code)
    assert.notEqual(code, originalCode)

    const confirmed = await send('dynamic-e2e-confirm', `/bot confirm ${code}`)
    assert.match(confirmed, /自动加入你的 Fleet roster/u)
    const joinedStatus = await gateway.fleetStatus()
    const joined = joinedStatus.fleet.registryBots.find(bot => bot.handle === 'analyst')
    assert.equal(joined?.fleetMembership, 'joined')
    assert.equal(joined?.runtimeReady, true)
    assert.equal(gateway.directory.canInvoke('analyst', ownerTarget), true)
    assert.equal(gateway.directory.canInvoke('analyst', {
      platform: 'feishu', chatId: 'oc_other', chatType: 'dm', userId: 'ou_other',
    }), false)

    await send('dynamic-e2e-mention', '@analyst 请分析这个问题')
    await waitUntil(async () => {
      const status = await gateway.fleetStatus()
      return status.fleet.tasks.some(task => task.assignedTo === 'analyst' && task.status === 'completed')
    }, 'dynamic Bot did not complete a direct mention task')
    assert.ok(sent.some(item => item.text.includes('@analyst：')))

    await send('dynamic-e2e-peer-chain', '@analyst peer-chain')
    await waitUntil(async () => {
      const status = await gateway.fleetStatus()
      return status.fleet.tasks.some(task => task.assignedTo === 'reviewer' && task.status === 'completed')
    }, 'dynamic Bot could not route an authorized Bot-to-Bot Peer Message')
    assert.ok(prompts.some(item => item.preset === 'reviewer' && item.prompt.includes('sourceReport')))

    const manager = await gateway.planManagerTask({
      requester: 'user:feishu:ou_dynamic_owner',
      replyTarget: ownerTarget,
      instruction: 'Analyze the requested topic',
      requiredCapabilities: ['analysis'],
      maxAssignments: 1,
    })
    assert.equal(manager.plan.policyDecision, 'allow')
    assert.deepEqual(manager.plan.delegations.map(item => item.toBot), ['analyst'])
    assert.deepEqual(manager.dispatched.map(item => item.to), ['analyst'])
    await waitUntil(async () => (await gateway.fleetTaskDetail(manager.taskId, 'local-dashboard'))?.task.status === 'completed', 'Manager did not complete through the dynamic Bot')

    const workflow = await gateway.createWorkflowDefinition(workflowDraft(), 'user:feishu:ou_dynamic_owner')
    const launch = await gateway.launchWorkflowDefinition(
      workflow.id,
      'user:feishu:ou_dynamic_owner',
      ownerTarget,
      'user:feishu:ou_dynamic_owner',
      { launchId: 'dynamic-fleet-e2e', inputs: { topic: 'dynamic fleet' } },
    )
    assert.deepEqual(launch.dispatched.map(item => item.to), ['analyst'])
    await waitUntil(async () => (await gateway.fleetTaskDetail(launch.rootTaskId, 'local-dashboard'))?.task.status === 'completed', 'Workflow did not complete through the dynamic Bot')
    assert.ok(prompts.some(item => item.preset === 'analyst' && item.prompt.includes('dynamic fleet')))

    await gateway.stop()
    gateway = undefined
    restarted = new BotGateway(context, dynamicFleetConfig(root))
    activeGateway = restarted
    attachTransport(restarted)
    await restarted.start()
    const recovered = await restarted.fleetStatus()
    const recoveredBot = recovered.fleet.registryBots.find(bot => bot.handle === 'analyst')
    assert.equal(recoveredBot?.fleetMembership, 'joined')
    assert.equal(restarted.directory.canInvoke('analyst', ownerTarget), true)
  } finally {
    if (gateway) await gateway.stop()
    if (restarted) await restarted.stop()
    await rm(root, { recursive: true, force: true })
  }
})
