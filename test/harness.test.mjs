import test from 'node:test'
import assert from 'node:assert/strict'
import { agentOptions, profileOptions } from '../dist/harness-bridge.js'

test('model overrides apply provider and model while retaining profile defaults when omitted', () => {
  assert.deepEqual(
    profileOptions({ name: 'default', provider: 'profile-provider', model: 'profile-model' }, {
      provider: 'override-provider',
      model: 'override-model',
    }),
    { provider: 'override-provider', model: 'override-model' },
  )
  assert.deepEqual(
    profileOptions({ name: 'default', provider: 'profile-provider', model: 'profile-model' }, { model: 'override-model' }),
    { provider: 'profile-provider', model: 'override-model' },
  )
})

test('programmatic agents inherit DSH default model before profile overrides', () => {
  const ctx = {
    get(name) {
      if (name !== 'agentDefaultModel') return undefined
      return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
    },
  }
  assert.deepEqual(agentOptions(ctx, { name: 'default' }), {
    provider: 'default-provider',
    model: 'default-model',
  })
  assert.deepEqual(agentOptions(ctx, { name: 'default', model: 'profile-model' }, { model: 'override-model' }), {
    provider: 'default-provider',
    model: 'override-model',
  })
})
