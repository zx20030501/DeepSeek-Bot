import assert from 'node:assert/strict'
import test from 'node:test'
import { FleetV2Panel, workflowToDraft } from '../dist/fleet-v2-panel.js'

function workflow(id, name, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    revision: 2,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    name,
    description: name + ' description',
    ownerId: 'user:feishu:ou_test',
    scope: 'user',
    entryNodeId: 'start',
    nodes: [
      { id: 'start', label: 'Start', kind: 'task', capability: 'start', outputs: ['result'] },
      { id: 'finish', label: 'Finish', kind: 'task', capability: 'work', outputs: ['result'] },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    inputs: [],
    outputs: [],
    policy: {
      budget: { maxDepth: 8, maxParallel: 2, maxFanOut: 2, maxMessages: 20, maxTokens: 20000, maxCostUnits: 100 },
      allowedCapabilities: ['start', 'work'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
    ...overrides,
  }
}

function childrenOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const props = node.props
  if (props === null || props === undefined || typeof props !== 'object') return []
  const children = props.children
  if (children === undefined) return []
  return Array.isArray(children) ? children : [children]
}

function findByTestId(node, testId) {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current !== null && typeof current === 'object') {
      const props = current.props
      if (props !== null && typeof props === 'object' && props['data-testid'] === testId) return current
      for (const child of childrenOf(current)) stack.push(child)
    }
  }
  return undefined
}

test('FleetV2Panel is a side-effect-free presentational component', () => {
  const element = FleetV2Panel({ workflows: [], plans: [], teams: [], threads: [], bots: [], audit: [] })
  assert.equal(typeof element, 'object')
  assert.equal(element.props['data-testid'], 'fleet-v2-panel')
})

test('workflow manager lists saved workflows with launch, status and edit actions', () => {
  const launched = []
  const statuses = []
  const selected = []
  const element = FleetV2Panel({
    workflows: [workflow('wf-1', 'Research flow'), workflow('wf-2', 'Report flow')],
    plans: [],
    teams: [],
    threads: [],
    bots: [],
    audit: [],
    onLaunchWorkflow: id => launched.push(id),
    onSetWorkflowStatus: (id, status) => statuses.push([id, status]),
    onSelectWorkflow: id => selected.push(id),
  })
  assert.ok(findByTestId(element, 'wf-row-wf-1'))
  assert.ok(findByTestId(element, 'wf-row-wf-2'))
  const launch = findByTestId(element, 'wf-launch-wf-1')
  assert.equal(typeof launch.props.onClick, 'function')
  launch.props.onClick()
  assert.deepEqual(launched, ['wf-1'])
  const status = findByTestId(element, 'wf-status-wf-1')
  status.props.onClick()
  assert.deepEqual(statuses, [['wf-1', 'deleted']])
  const status2 = findByTestId(element, 'wf-status-wf-2')
  status2.props.onClick()
  assert.deepEqual(statuses, [['wf-1', 'deleted'], ['wf-2', 'deleted']])
  const edit = findByTestId(element, 'wf-edit-wf-2')
  edit.props.onClick()
  assert.deepEqual(selected, ['wf-2'])
  assert.ok(findByTestId(element, 'wf-new'))
})

test('workflow editor renders a form with prefilled JSON when open', () => {
  const draft = workflowToDraft(workflow('wf-9', 'Editor flow'))
  assert.equal(draft.name, 'Editor flow')
  assert.equal(draft.entryNodeId, 'start')
  assert.match(draft.nodesJson, /"start"/u)
  assert.match(draft.policyJson, /maxParallel/u)
  const created = []
  const updated = []
  const element = FleetV2Panel({
    workflows: [workflow('wf-9', 'Editor flow')],
    plans: [],
    teams: [],
    threads: [],
    bots: [],
    audit: [],
    workflowEditorOpen: true,
    workflowEditorDefault: draft,
    workflowEditorWorkflowId: 'wf-9',
    onCreateWorkflow: value => created.push(value),
    onUpdateWorkflow: (id, value) => updated.push([id, value]),
  })
  const editor = findByTestId(element, 'wf-editor')
  assert.ok(editor)
  assert.ok(findByTestId(element, 'wf-name'))
  assert.ok(findByTestId(element, 'wf-nodes'))
  assert.ok(findByTestId(element, 'wf-policy'))
  const save = findByTestId(element, 'wf-save')
  assert.equal(typeof save.props.onClick, 'function')
  // The editor is also reachable for a fresh create (no workflow id).
  const createPanel = FleetV2Panel({
    workflows: [],
    plans: [],
    teams: [],
    threads: [],
    bots: [],
    audit: [],
    workflowEditorOpen: true,
    workflowEditorDefault: draft,
    onCreateWorkflow: value => created.push(value),
  })
  const createSave = findByTestId(createPanel, 'wf-save')
  assert.equal(typeof createSave.props.onClick, 'function')
  assert.ok(findByTestId(createPanel, 'wf-cancel'))
})

test('workflowToDraft serializes every graph section as pretty JSON', () => {
  const draft = workflowToDraft(workflow('wf-7', 'Serialize me'))
  assert.equal(draft.entryNodeId, 'start')
  assert.equal(draft.inputsJson, '[]')
  assert.equal(draft.outputsJson, '[]')
  assert.match(draft.edgesJson, /"to":\s*"finish"/u)
  assert.match(draft.nodesJson, /"kind":\s*"task"/u)
})
