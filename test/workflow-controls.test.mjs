import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compensationNodeIds,
  evaluateWorkflowCondition,
  mapWorkflowValues,
  parseWorkflowResult,
  reduceWorkflowValues,
  resolveWorkflowInputs,
  resolveWorkflowReference,
  selectWorkflowOutput,
  serializeWorkflowResult,
} from '../dist/workflow-controls.js'

test('Workflow controls resolve structured and legacy outputs deterministically', () => {
  const outputs = new Map([
    ['research', { result: 'answer', score: 0.9 }],
    ['legacy', parseWorkflowResult('plain text')],
  ])
  assert.equal(resolveWorkflowReference({ kind: 'node-output', nodeId: 'research', output: 'score' }, {}, outputs), 0.9)
  assert.equal(resolveWorkflowReference({ kind: 'node-output', nodeId: 'research', output: 'result' }, {}, outputs), 'answer')
  assert.equal(selectWorkflowOutput(outputs.get('legacy'), 'result'), 'plain text')
  assert.deepEqual(resolveWorkflowInputs({
    inputs: [
      { name: 'score', source: { kind: 'node-output', nodeId: 'research', output: 'score' } },
      { name: 'topic', source: { kind: 'input', name: 'topic' } },
    ],
  }, { topic: 'Hermes' }, outputs), { score: 0.9, topic: 'Hermes' })
  assert.equal(serializeWorkflowResult({ ok: true }), '{"ok":true}')
  assert.equal(parseWorkflowResult(serializeWorkflowResult(undefined)), undefined)
})

test('condition equality is stable for canonically distinct Unicode keys', () => {
  const composed = '\u00e9'
  const decomposed = 'e\u0301'
  const left = { [composed]: 1, [decomposed]: 2 }
  const right = { [decomposed]: 2, [composed]: 1 }
  assert.equal(evaluateWorkflowCondition({
    source: { kind: 'constant', value: left },
    operator: 'equals',
    value: right,
    whenTrue: 'yes',
  }, {}, new Map()).matched, true)
})

test('condition operators cover equality, existence, truthiness and containment', () => {
  const outputs = new Map([['source', { result: ['a', 'b'], flag: true }]])
  const context = { kind: 'node-output', nodeId: 'source', output: 'result' }
  assert.equal(evaluateWorkflowCondition({ source: context, operator: 'contains', value: 'b', whenTrue: 'yes' }, {}, outputs).matched, true)
  assert.equal(evaluateWorkflowCondition({ source: { kind: 'node-output', nodeId: 'source', output: 'flag' }, operator: 'truthy', whenTrue: 'yes' }, {}, outputs).matched, true)
  assert.equal(evaluateWorkflowCondition({ source: context, operator: 'equals', value: 'a', whenTrue: 'yes' }, {}, outputs).matched, false)
  assert.equal(evaluateWorkflowCondition({ source: context, operator: 'exists', whenTrue: 'yes' }, {}, outputs).matched, true)
})

test('map and reduce are bounded and deterministic', () => {
  const values = new Map([['source', [1, 2, 3]]])
  assert.deepEqual(mapWorkflowValues({ source: { kind: 'node-output', nodeId: 'source', output: 'result' }, itemInput: 'item', templateNodeId: 'worker' }, {}, values, 3), [1, 2, 3])
  assert.deepEqual(reduceWorkflowValues({ source: { kind: 'node-output', nodeId: 'source', output: 'result' }, reducer: 'concat' }, {}, new Map([['source', [[1], [2]]]])), [1, 2])
  assert.equal(reduceWorkflowValues({ source: { kind: 'node-output', nodeId: 'source', output: 'result' }, reducer: 'count' }, {}, values), 3)
  assert.equal(reduceWorkflowValues({ source: { kind: 'node-output', nodeId: 'source', output: 'result' }, reducer: 'all-success', }, {}, new Map([['source', [{ status: 'completed' }, { status: 'ok' }]]])), true)
  assert.throws(() => mapWorkflowValues({ source: { kind: 'constant', value: 'not-array' }, itemInput: 'item', templateNodeId: 'worker' }, {}, new Map(), 3), /array/u)
  assert.throws(() => mapWorkflowValues({ source: { kind: 'constant', value: [1] }, itemInput: 'item', templateNodeId: 'worker' }, {}, new Map(), 0), /fan-out/u)
})

test('compensation targets are reverse-ordered and deduplicated', () => {
  const definition = {
    schemaVersion: 1,
    id: 'wf_comp',
    revision: 1,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    name: 'compensation',
    ownerId: 'user:a',
    scope: 'user',
    entryNodeId: 'a',
    inputs: [],
    outputs: [],
    edges: [],
    policy: { budget: { maxDepth: 4, maxParallel: 2, maxFanOut: 4, maxMessages: 10, maxTokens: 10, maxCostUnits: 10 }, allowExternalEffects: false },
    nodes: [
      { id: 'a', label: 'A', kind: 'task', compensation: { nodeId: 'undo-a', on: 'failure' } },
      { id: 'b', label: 'B', kind: 'task', compensation: { nodeId: 'undo-b', on: 'failure' } },
      { id: 'undo-a', label: 'Undo A', kind: 'task' },
      { id: 'undo-b', label: 'Undo B', kind: 'task' },
    ],
  }
  assert.deepEqual(compensationNodeIds(definition, ['a', 'b'], 'failure'), ['undo-b', 'undo-a'])
})
