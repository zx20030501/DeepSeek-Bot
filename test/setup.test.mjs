import test from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayConfigFromSettings,
  parseIdList,
  settingsFromGatewayConfig,
} from '../dist/setup.js'

test('parses user and chat IDs from the simple setup form', () => {
  assert.deepEqual(parseIdList('ou_a, ou_b\noc_a；ou_a'), ['ou_a', 'ou_b', 'oc_a'])
})

test('projects gateway defaults into settings without exposing the App Secret', () => {
  const config = {
    enabled: true,
    access: { mode: 'allowlist', userIds: ['ou_old'], chatIds: [] },
    feishu: {
      enabled: true,
      appId: 'cli_old',
      appSecret: 'secret-from-env',
      domain: 'feishu',
      requireMention: true,
    },
  }
  const settings = settingsFromGatewayConfig(config)
  assert.deepEqual(settings.feishu, {
    enabled: true,
    appId: 'cli_old',
    domain: 'feishu',
    requireMention: true,
  })
  assert.equal('appSecret' in settings.feishu, false)
})

test('merges saved setup values and keeps non-form gateway options', () => {
  const config = {
    enabled: true,
    defaultProfile: 'research',
    profiles: { research: { model: 'deepseek-v4-flash' } },
    feishu: { enabled: false, appId: 'cli_old', appSecret: 'old-secret' },
    access: { mode: 'open', notifyUnauthorized: true },
  }
  const next = gatewayConfigFromSettings(config, {
    enabled: true,
    feishu: { enabled: true, appId: 'cli_new', domain: 'lark', requireMention: false },
    access: { userIds: ['ou_new'], chatIds: [], pairing: true },
  }, 'new-secret')
  assert.equal(next.defaultProfile, 'research')
  assert.equal(next.profiles?.research?.model, 'deepseek-v4-flash')
  assert.deepEqual(next.feishu, {
    enabled: true,
    appId: 'cli_new',
    appSecret: 'new-secret',
    domain: 'lark',
    requireMention: false,
  })
  assert.deepEqual(next.access, {
    mode: 'allowlist',
    notifyUnauthorized: true,
    pairing: true,
    userIds: ['ou_new'],
    chatIds: [],
  })
})

test('Fleet roster settings round-trip roles, ACLs, session isolation, and limits', () => {
  const base = {
    profiles: {
      researcher: {
        title: 'Researcher',
        model: 'deepseek-reasoner',
        capabilities: ['research'],
        allowedUserIds: ['ou_a'],
        fleetRole: 'worker',
        sessionScope: 'requester',
      },
    },
    collaboration: { approvalMode: 'auto-planned', maxGroupRounds: 3 },
  }
  const settings = settingsFromGatewayConfig(base)
  assert.equal(settings.profiles[0]?.id, 'researcher')
  assert.deepEqual(settings.profiles[0]?.allowedUserIds, ['ou_a'])
  settings.profiles[0].approvalRequired = true
  settings.collaboration.maxParallelRuns = 4
  const next = gatewayConfigFromSettings(base, settings)
  assert.equal(next.profiles?.researcher?.approvalRequired, true)
  assert.equal(next.profiles?.researcher?.sessionScope, 'requester')
  assert.equal(next.collaboration?.maxParallelRuns, 4)
  assert.equal(next.collaboration?.maxGroupRounds, 3)
})
