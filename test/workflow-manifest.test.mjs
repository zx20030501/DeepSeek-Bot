import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'

const target = { platform: 'feishu', chatId: 'oc_wf', chatType: 'dm', userId: 'ou_user' }

function draft(name) {
  return {
    name,
    description: 'manifest test',
    ownerId: 'user:feishu:ou_user',
    scope: 'user',
    entryNodeId: 'start',
    inputs: [],
    outputs: [],
    nodes: [
      { id: 'start', label: 'Start', kind: 'task', capability: 'start', outputs: ['result'] },
      { id: 'finish', label: 'Finish', kind: 'task', capability: 'work', outputs: ['result'] },
    ],
    edges: [{ from: 'start', to: 'finish' }],
    policy: {
      budget: { maxDepth: 8, maxParallel: 2, maxFanOut: 2, maxMessages: 20, maxTokens: 20_000, maxCostUnits: 100 },
      allowedCapabilities: ['start', 'work'],
      allowedPermissions: [],
      allowExternalEffects: false,
    },
  }
}

async function makeGateway(root) {
  const gateway = new BotGateway({ get: () => undefined }, {
    stateDir: root,
    access: { userIds: ['ou_user'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: { starter: { capabilities: ['start'] }, worker: { capabilities: ['work'] } },
    collaboration: { enabled: true, approvalMode: 'never', features: { savedWorkflows: true } },
  })
  gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
  gateway.transportByPlatform.set('feishu', gateway.transports[0])
  await gateway.start()
  return gateway
}

test('Workflow manifests export and import across gateways with checksum protection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-workflow-manifest-'))
  let source
  let destination
  try {
    source = await makeGateway(join(root, 'source'))
    const created = await source.createWorkflowDefinition(draft('Portable flow'), 'user:feishu:ou_user')

    const manifest = await source.exportWorkflowManifest(created.id, 'user:feishu:ou_user')
    assert.equal(manifest.manifestVersion, 1)
    assert.equal(manifest.workflow.id, created.id)
    assert.equal(manifest.workflow.revision, created.revision)
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/u)

    // A fresh gateway imports the manifest; the owner becomes the importer.
    destination = await makeGateway(join(root, 'destination'))
    const imported = await destination.importWorkflowManifest(manifest, 'user:feishu:ou_user')
    assert.equal(imported.name, 'Portable flow')
    assert.equal(imported.ownerId, 'user:feishu:ou_user')
    assert.equal(imported.nodes.length, 2)
    const listed = await destination.listWorkflowDefinitions('user:feishu:ou_user')
    assert.ok(listed.some(workflow => workflow.id === imported.id))

    // Tampering with the payload breaks the checksum.
    const tampered = { ...manifest, workflow: { ...manifest.workflow, name: 'Tampered flow' } }
    await assert.rejects(
      () => destination.importWorkflowManifest(tampered, 'user:feishu:ou_user'),
      /checksum/u,
    )
  } finally {
    if (destination) await destination.stop()
    if (source) await source.stop()
    await rm(root, { recursive: true, force: true })
  }
})
