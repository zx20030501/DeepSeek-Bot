import test from 'node:test'
import assert from 'node:assert/strict'
import { discoveryCandidateFor, nextModelOverride, normalizeConfig } from '../dist/gateway.js'

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
