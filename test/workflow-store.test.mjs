import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkflowStore, WorkflowStoreError } from '../dist/workflow-store.js'

const draft = (overrides = {}) => ({
  name: 'Research workflow',
  description: 'A small product-layer workflow',
  ownerId: 'user:a',
  scope: 'user',
  entryNodeId: 'research',
  nodes: [
    { id: 'research', label: 'Research', kind: 'task', capability: 'research', outputs: ['result'] },
    { id: 'write', label: 'Write', kind: 'task', capability: 'write', inputs: [{ name: 'evidence', source: { kind: 'node-output', nodeId: 'research', output: 'result' } }], outputs: ['result'] },
  ],
  edges: [{ from: 'research', to: 'write' }],
  inputs: [{ name: 'topic', type: 'string' }],
  outputs: [{ name: 'answer', source: { kind: 'node-output', nodeId: 'write', output: 'result' } }],
  policy: {
    budget: { maxDepth: 8, maxParallel: 4, maxFanOut: 10, maxMessages: 20, maxTokens: 10_000, maxCostUnits: 100 },
  },
  ...overrides,
})

async function withStore(callback) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-store-'))
  try {
    return await callback(join(root, 'workflows.jsonl'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('creates, updates, lists and idempotently repeats Workflow writes', async () => {
  await withStore(async file => {
    const store = new WorkflowStore(file)
    const created = await store.create(draft(), 'user:a', 'create-1', 100)
    const repeatedCreate = await store.create(draft(), 'user:a', 'create-1', 101)
    assert.equal(repeatedCreate.id, created.id)
    assert.equal(repeatedCreate.revision, 1)

    const updated = await store.update(created.id, { name: 'Updated workflow' }, 'user:a', 1, 'update-1', 200)
    const repeatedUpdate = await store.update(created.id, { name: 'Updated workflow' }, 'user:a', 1, 'update-1', 201)
    assert.equal(updated.revision, 2)
    assert.equal(repeatedUpdate.revision, 2)
    assert.equal((await store.list({ actorId: 'user:a' })).length, 1)
    assert.equal((await store.get(created.id, { actorId: 'user:b' })), undefined)
    await assert.rejects(store.update(created.id, { name: 'stale' }, 'user:a', 1), error => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_VERSION_CONFLICT')
  })
})

test('persists immutable revisions across reload and repairs a torn JSONL tail', async () => {
  await withStore(async file => {
    const initial = new WorkflowStore(file)
    const created = await initial.create(draft(), 'user:a', 'create-2', 100)
    const updated = await initial.update(created.id, { description: 'revision two' }, 'user:a', 1, 'update-2', 200)
    await appendFile(file, '{"schemaVersion":1,"eventId":"torn"', 'utf8')
    const recovered = new WorkflowStore(file)
    assert.equal((await recovered.get(created.id, { actorId: 'user:a' }))?.revision, updated.revision)
    assert.equal((await recovered.getRevision(created.id, 1, { actorId: 'user:a' }))?.description, created.description)
    const repaired = await recovered.update(created.id, { description: 'revision three' }, 'user:a', 2, 'update-3', 300)
    assert.equal(repaired.revision, 3)
  })
})

test('soft deletes without erasing history and supports export/import manifests', async () => {
  await withStore(async file => {
    const store = new WorkflowStore(file)
    const created = await store.create(draft({ tags: ['research'] }), 'user:a', 'create-3', 100)
    const manifest = await store.exportManifest(created.id, { actorId: 'user:a' }, 150)
    assert.equal(manifest.manifestVersion, 1)
    assert.equal(manifest.sha256.length, 64)
    const imported = await store.importManifest(manifest, 'user:b', 'import-1', 200)
    assert.notEqual(imported.id, created.id)
    assert.equal(imported.ownerId, 'user:b')
    assert.equal((await store.get(imported.id, { actorId: 'user:a' })), undefined)
    assert.ok(await store.get(imported.id, { actorId: 'user:b' }))

    const deleted = await store.softDelete(created.id, 'user:a', 1, 'delete-1', 250)
    assert.equal(deleted.status, 'deleted')
    assert.equal(await store.get(created.id, { actorId: 'user:a' }), undefined)
    assert.equal((await store.get(created.id, { actorId: 'user:a' }, true))?.status, 'deleted')
    assert.equal((await store.list({ actorId: 'user:a' }, true)).length, 1)
  })
})

test('rejects credential-bearing definitions and conflicting idempotency keys', async () => {
  await withStore(async file => {
    const store = new WorkflowStore(file)
    await assert.rejects(
      store.create(draft({ description: `token=${'a'.repeat(24)}` }), 'user:a', 'credential-1'),
      error => error?.code === 'WORKFLOW_CREDENTIAL_MATERIAL',
    )
    await store.create(draft(), 'user:a', 'same-key', 100)
    await assert.rejects(
      store.create(draft({ name: 'different' }), 'user:a', 'same-key', 101),
      error => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_IDEMPOTENCY_CONFLICT',
    )
  })
})

test('keeps shared Workflows visible while preserving user-scoped isolation', async () => {
  await withStore(async file => {
    const store = new WorkflowStore(file)
    await store.create(draft({ name: 'Private' }), 'user:a', 'private', 100)
    await store.create(draft({ name: 'Shared', ownerId: 'user:a', scope: 'shared' }), 'user:a', 'shared', 101)
    assert.equal((await store.list({ actorId: 'user:b' })).map(item => item.name).join(','), 'Shared')
  })
})
