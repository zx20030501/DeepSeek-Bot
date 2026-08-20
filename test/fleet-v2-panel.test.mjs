import assert from 'node:assert/strict'
import test from 'node:test'
import { FleetV2Panel } from '../dist/fleet-v2-panel.js'

test('FleetV2Panel is a side-effect-free presentational component', () => {
  const element = FleetV2Panel({ workflows: [], plans: [], teams: [], threads: [], bots: [], audit: [] })
  assert.equal(typeof element, 'object')
  assert.equal(element.props['data-testid'], 'fleet-v2-panel')
})
