import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { GroupRoomStore } from '../dist/collaboration.js'

function withMockSession(agent) {
  const events = []
  const session = {
    get events() {
      return events
    },
    get seq() {
      return events.length
    },
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
  }
  agent.session = session
  agent.whenIdle ??= async () => {}
  return agent
}

test('Group Room watermark (projectedCount) advances monotonically and caps messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-room-watermark-'))
  try {
    const rooms = new GroupRoomStore(join(root, 'rooms.json'), { maxGroupRounds: 100, maxGroupMessages: 4 })
    const room = await rooms.open({ platform: 'feishu', chatId: 'oc_room', chatType: 'group' }, 'task_1', ['a', 'b'])
    await rooms.append(room.id, 'user:feishu:ou_user', 'm1')
    await rooms.append(room.id, 'a', 'm2')
    await rooms.append(room.id, 'b', 'm3')
    await rooms.append(room.id, 'user:feishu:ou_user', 'm4')
    // Window is full: further appends are refused (messageCount never exceeds maxMessages).
    assert.equal(await rooms.append(room.id, 'a', 'm5'), undefined)
    const record = await rooms.get(room.id)
    assert.equal(record.messageCount, 4)
    assert.equal(record.messages.length, 4)

    // Watermark advances and never regresses.
    assert.equal((await rooms.markProjected(room.id, 2))?.projectedCount, 2)
    assert.equal((await rooms.markProjected(room.id, 1))?.projectedCount, 2, 'markProjected must not regress')
    assert.equal((await rooms.markProjected(room.id, 4))?.projectedCount, 4)
    assert.equal((await rooms.get(room.id)).projectedCount, 4)

    // Projection math: messages.length === messageCount, so windowStart is always 0.
    assert.equal(record.messageCount - record.messages.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('openWebDashboardRoom backfills the Group Room transcript and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-room-open-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) {
        return agents.get(String(id))
      },
      async resume({ resumeSessionId }) {
        const agent = agents.get(String(resumeSessionId))
        if (!agent) throw new Error('not found')
        return { agent }
      },
      async create({ sessionId, agentOptions }) {
        const agent = withMockSession({ id: sessionId, status: 'idle' })
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
        writer: { fleetRole: 'synthesizer', capabilities: ['summary'] },
      },
      collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
    })
    const transport = {
      platform: 'feishu',
      async start() {},
      async stop() {},
      async send() {},
      status() {
        return { running: true, connected: true }
      },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()
    assert.ok(gateway.bridge, 'bridge should be initialised after start')

    // Seed a Group Room with a transcript.
    const room = await gateway.rooms.open({ platform: 'feishu', chatId: 'oc_room', chatType: 'group' }, 'task_1', ['researcher', 'writer'])
    await gateway.rooms.append(room.id, 'user:feishu:ou_user', '合并这两篇文章')
    await gateway.rooms.append(room.id, 'researcher', '研究结论：A 优于 B')
    await gateway.rooms.append(room.id, 'writer', '总结：建议采用 A')

    // Register the middle-column projection session so the bridge can deliver into it.
    const groupSessionId = 'hermes-group-' + room.id
    const groupAgent = withMockSession({ id: groupSessionId, status: 'idle' })
    agents.set(groupSessionId, groupAgent)

    const result = await gateway.openWebDashboardRoom(room.id)
    assert.equal(result.sessionId, groupSessionId)
    assert.equal(result.title, '群聊 · @researcher、@writer')
    assert.equal(result.participants.join(','), 'researcher,writer')

    const delivered = groupAgent.session.events.filter(event => event.type === 'user/message')
    assert.equal(delivered.length, 3, 'all three transcript lines should be projected')
    assert.ok(delivered[0].data.content[0].text.startsWith('@user：'), 'user line is attributed to @user')
    assert.ok(delivered[1].data.content[0].text.startsWith('@researcher：'), 'bot line is attributed to @researcher')
    assert.ok(delivered[2].data.content[0].text.startsWith('@writer：'), 'writer line is attributed to @writer')
    assert.ok(delivered[2].data.content[0].text.includes('建议采用 A'), 'transcript text is preserved')

    // Idempotent: a second open must not re-deliver.
    const beforeCount = groupAgent.session.events.length
    await gateway.openWebDashboardRoom(room.id)
    assert.equal(groupAgent.session.events.length, beforeCount, 're-opening must not duplicate transcript')

    // A new line appended later is projected on the next open (watermark advances).
    await gateway.rooms.append(room.id, 'researcher', '补充：注意边界情况')
    await gateway.openWebDashboardRoom(room.id)
    const after = groupAgent.session.events.filter(event => event.type === 'user/message')
    assert.equal(after.length, 4, 'only the new line is appended')
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('openWebDashboardRoom rejects unknown rooms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-room-missing-'))
  let gateway
  try {
    const agents = new Map()
    const registry = {
      get(id) {
        return agents.get(String(id))
      },
      async resume() {
        throw new Error('not found')
      },
      async create() {
        throw new Error('not found')
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
      collaboration: { enabled: true, approvalMode: 'never', mailboxLeaseMs: 5_000 },
    })
    const transport = {
      platform: 'feishu',
      async start() {},
      async stop() {},
      async send() {},
      status() {
        return { running: true, connected: true }
      },
    }
    gateway.transports = [transport]
    gateway.transportByPlatform.set('feishu', transport)
    await gateway.start()

    await assert.rejects(() => gateway.openWebDashboardRoom('room_does_not_exist'), /群房间不存在/)
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
