import test from 'node:test'
import assert from 'node:assert/strict'
import { discoveryCandidateFor, nextModelOverride } from '../dist/gateway.js'

test('discovery accepts only the exact one-time command and captures the sender ID', () => {
  const message = {
    id: 'feishu:message:1',
    target: { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_sender' },
    text: '/bind 123456',
    receivedAt: Date.now(),
  }
  const candidate = discoveryCandidateFor(message, '/bind 123456')
  assert.equal(candidate?.userId, 'ou_sender')
  assert.equal(candidate?.chatId, 'oc_chat')
  assert.equal(discoveryCandidateFor({ ...message, text: '/bind 654321' }, '/bind 123456'), undefined)
})

test('profile switching can clear an old model override while new model commands replace it', () => {
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, null), {})
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, undefined), { modelOverride: 'old-model' })
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, {
    provider: 'new-provider',
    model: 'new-model',
  }), { modelOverride: { provider: 'new-provider', model: 'new-model' } })
})
