import test from 'node:test'
import assert from 'node:assert/strict'
import { nextModelOverride } from '../dist/gateway.js'

test('profile switching can clear an old model override while new model commands replace it', () => {
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, null), {})
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, undefined), { modelOverride: 'old-model' })
  assert.deepEqual(nextModelOverride({ modelOverride: 'old-model' }, {
    provider: 'new-provider',
    model: 'new-model',
  }), { modelOverride: { provider: 'new-provider', model: 'new-model' } })
})
