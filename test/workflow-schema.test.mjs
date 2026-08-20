import assert from 'node:assert/strict'
import test from 'node:test'
import { assertValidWorkflow, validateWorkflow } from '../dist/workflow-schema.js'

const policy = (overrides = {}) => ({
  budget: {
    maxDepth: 12,
    maxParallel: 6,
    maxFanOut: 20,
    maxMessages: 100,
    maxTokens: 100_000,
    maxCostUnits: 1_000,
    ...overrides,
  },
  allowedCapabilities: ['research', 'write', 'review'],
  allowedPermissions: ['read'],
  allowExternalEffects: false,
})

function validWorkflow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'wf_valid',
    revision: 1,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    name: 'Validated workflow',
    ownerId: 'user:a',
    scope: 'user',
    entryNodeId: 'start',
    inputs: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'finish', output: 'result' } }],
    nodes: [
      {
        id: 'start',
        label: 'Research',
        kind: 'task',
        capability: 'research',
        permissions: ['read'],
        inputs: [{ name: 'topic', source: { kind: 'input', name: 'topic' } }],
        outputs: ['result'],
        costUnits: 10,
        tokenBudget: 1_000,
        messageBudget: 2,
      },
      {
        id: 'finish',
        label: 'Write result',
        kind: 'task',
        capability: 'write',
        permissions: ['read'],
        inputs: [{ name: 'research', source: { kind: 'node-output', nodeId: 'start', output: 'result' } }],
        outputs: ['result'],
      },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    policy: policy(),
    ...overrides,
  }
}

test('validates a serializable Workflow with references, capabilities and budgets', () => {
  const result = validateWorkflow(validWorkflow())
  assert.equal(result.ok, true)
  assert.equal(result.definition?.schemaVersion, 1)
  assert.equal(result.definition?.nodes.length, 2)
})

test('rejects cycles and orphan nodes with stable diagnostic codes', () => {
  const result = validateWorkflow(validWorkflow({
    nodes: [
      { id: 'start', label: 'Start', kind: 'task', capability: 'research', outputs: ['result'] },
      { id: 'finish', label: 'Finish', kind: 'task', capability: 'write', outputs: ['result'] },
      { id: 'orphan', label: 'Orphan', kind: 'task', capability: 'write', outputs: ['result'] },
    ],
    edges: [
      { from: 'start', to: 'finish' },
      { from: 'finish', to: 'start' },
    ],
  }))
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(item => item.code === 'WORKFLOW_CYCLE'))
  assert.ok(result.diagnostics.some(item => item.code === 'WORKFLOW_ORPHAN_NODE'))
})

test('rejects unknown node outputs and unknown edge endpoints', () => {
  const result = validateWorkflow(validWorkflow({
    nodes: [{
      id: 'start',
      label: 'Start',
      kind: 'task',
      capability: 'research',
      inputs: [{ name: 'missing', source: { kind: 'node-output', nodeId: 'ghost', output: 'result' } }],
      outputs: ['result'],
    }],
    edges: [{ from: 'start', to: 'ghost' }],
    outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'start', output: 'unknown' } }],
  }))
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.filter(item => item.code === 'WORKFLOW_UNKNOWN_REFERENCE').length >= 2)
  assert.ok(result.diagnostics.some(item => item.code === 'WORKFLOW_UNKNOWN_NODE'))
})

test('rejects executable input, credential material, and undeclared effects', () => {
  const unsafe = validateWorkflow(validWorkflow({ description: 'javascript: eval(input)' }))
  assert.equal(unsafe.ok, false)
  assert.ok(unsafe.diagnostics.some(item => item.code === 'WORKFLOW_UNSAFE_INPUT'))

  const credential = validateWorkflow(validWorkflow({
    outputs: [{ name: 'answer', source: { kind: 'constant', value: `https://example.test/?api_key=${'a'.repeat(24)}` } }],
  }))
  assert.equal(credential.ok, false)
  assert.ok(credential.diagnostics.some(item => item.code === 'WORKFLOW_CREDENTIAL_MATERIAL'))

  const effect = validateWorkflow(validWorkflow({
    nodes: [
      { id: 'start', label: 'Send', kind: 'task', capability: 'research', effect: { kind: 'message-send', declaration: 'send a report' }, outputs: ['result'] },
      { id: 'finish', label: 'Finish', kind: 'task', capability: 'write', outputs: ['result'] },
    ],
  }))
  assert.equal(effect.ok, false)
  assert.ok(effect.diagnostics.some(item => item.code === 'WORKFLOW_EXTERNAL_EFFECT_UNDECLARED'))
})

test('enforces policy depth and aggregate resource limits', () => {
  const result = validateWorkflow(validWorkflow({
    policy: policy({ maxDepth: 1, maxTokens: 10, maxMessages: 1, maxCostUnits: 1 }),
  }))
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(item => item.code === 'WORKFLOW_DEPTH_EXCEEDED'))
  assert.ok(result.diagnostics.some(item => item.code === 'WORKFLOW_POLICY_VIOLATION'))
})

test('assertValidWorkflow throws a typed validation error', () => {
  assert.throws(
    () => assertValidWorkflow(validWorkflow({ id: 'INVALID ID' })),
    error => error?.name === 'WorkflowValidationError' && error?.code === 'WORKFLOW_INVALID_ID',
  )
})

test('supports structured condition, map, reduce, approval, retry, timeout and compensation nodes', () => {
  const definition = validWorkflow({
    entryNodeId: 'condition',
    nodes: [
      { id: 'condition', label: 'Condition', kind: 'condition', condition: { source: { kind: 'input', name: 'topic' }, operator: 'exists', whenTrue: 'map', whenFalse: 'map' } },
      { id: 'map', label: 'Fan out', kind: 'map', map: { source: { kind: 'input', name: 'topic' }, itemInput: 'item', templateNodeId: 'worker', maxFanOut: 5 } },
      { id: 'worker', label: 'Worker', kind: 'task', capability: 'research', outputs: ['result'] },
      { id: 'reduce', label: 'Reduce', kind: 'reduce', reduce: { source: { kind: 'node-output', nodeId: 'worker', output: 'result' }, reducer: 'concat' }, outputs: ['result'] },
      { id: 'approval', label: 'Approve', kind: 'approval', approval: { risk: 'medium', requestedBy: 'requester', reason: 'Review output' } },
      { id: 'retry', label: 'Retry', kind: 'retry', retry: { maxAttempts: 2, backoffMs: 100 } },
      { id: 'timeout', label: 'Timeout', kind: 'timeout', timeout: { timeoutMs: 1_000 } },
      { id: 'compensation', label: 'Compensation', kind: 'compensation', compensation: { nodeId: 'cleanup', on: 'failure' } },
      { id: 'cleanup', label: 'Cleanup', kind: 'task', capability: 'write', outputs: ['result'] },
    ],
    edges: [
      { from: 'condition', to: 'map' },
      { from: 'map', to: 'worker' },
      { from: 'worker', to: 'reduce' },
      { from: 'reduce', to: 'approval' },
      { from: 'approval', to: 'retry' },
      { from: 'retry', to: 'timeout' },
      { from: 'timeout', to: 'compensation' },
      { from: 'compensation', to: 'cleanup' },
    ],
    outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'reduce', output: 'result' } }],
  })
  const result = validateWorkflow(definition)
  assert.equal(result.ok, true)
})
