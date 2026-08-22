import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../dist/bot-registry.js'
import { BotGateway } from '../dist/gateway.js'

test('500 persisted logical Bots load into an owner-scoped Fleet roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-dynamic-scale-'))
  let gateway
  try {
    const actor = 'user:feishu:ou_scale'
    const registry = new BotRegistry(join(root, 'bot-registry.jsonl'))
    for (let index = 0; index < 500; index += 1) {
      await registry.create({
        handle: `logical-${String(index).padStart(3, '0')}`,
        scope: 'user',
        ownerId: actor,
        source: 'import',
        status: 'active',
        revision: {
          title: `Logical Bot ${index}`,
          capabilities: [`capability-${index}`],
          fleetRole: 'worker',
          sessionScope: 'requester',
          allowedUserIds: ['ou_scale'],
          allowedChatIds: [],
          approvalRequired: false,
        },
      }, actor, 1_000 + index)
    }

    gateway = new BotGateway({}, {
      stateDir: root,
      access: { userIds: ['ou_scale', 'ou_other'] },
      telegram: { enabled: false },
      feishu: { enabled: false },
      collaboration: {
        enabled: true,
        approvalMode: 'never',
        features: { dynamicRegistry: true, chatBotCreation: true },
      },
    })
    await gateway.start()
    const ownerTarget = { platform: 'feishu', chatId: 'oc_scale', chatType: 'dm', userId: 'ou_scale' }
    const otherTarget = { platform: 'feishu', chatId: 'oc_other', chatType: 'dm', userId: 'ou_other' }
    const status = await gateway.fleetStatus()
    assert.equal(status.collaboration.registry.active, 500)
    assert.equal(status.fleet.registryBots.filter(bot => bot.fleetMembership === 'joined').length, 500)
    assert.equal(gateway.directory.canInvoke('logical-499', ownerTarget), true)
    assert.equal(gateway.directory.canInvoke('logical-499', otherTarget), false)
    const plan = gateway.planner.plan('Use capability-499', gateway.directory, ownerTarget, 6)
    assert.ok([...plan.workerBotIds, plan.synthesizerBotId].includes('logical-499'))
  } finally {
    if (gateway) await gateway.stop()
    await rm(root, { recursive: true, force: true })
  }
})
