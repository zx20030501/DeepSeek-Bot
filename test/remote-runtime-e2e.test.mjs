import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { BotGateway } from '../dist/gateway.js'
import { RemoteDeliveryLedger, createRemoteTransportHandler } from '../dist/remote-transport.js'

const SECRET = 'e2e-remote-secret-for-tests'
process.env.DSH_REMOTE_TEST_SECRET = SECRET

async function waitUntil(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for condition')
}

/** Expose a gateway's remote receive over the signed HTTP transport contract. */
async function startRemoteServer(secret, ledgerFile, receive) {
  const ledger = new RemoteDeliveryLedger(ledgerFile)
  const handler = createRemoteTransportHandler(async message => receive(message), { sharedSecret: secret, ledger })
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      try {
        const request = new Request('http://127.0.0.1' + (req.url ?? '/'), {
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        const response = await handler(request)
        res.writeHead(response.status, { 'content-type': 'application/json' })
        res.end(await response.text())
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: false, errorCode: 'handler-error', error: String(error) }))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    server,
    url: 'http://127.0.0.1:' + port,
    ledger,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * Two real gateways joined by signed HTTP transports. Node B owns
 * `researcher`, executed through the external runtime adapter returned by
 * `adapterRun`. Returns the pair plus a stop() that tears everything down.
 */
async function twoNodeSetup(root, adapterRun) {
  let gatewayA
  let gatewayB
  let serverA
  let serverB
  let gatewayBRef = undefined
  serverB = await startRemoteServer(SECRET, join(root, 'node-b-inbox.jsonl'), message => (
    gatewayBRef === undefined ? Promise.resolve({ accepted: false, deliveryId: message.deliveryId }) : gatewayBRef.receiveRemoteBotMessage(message)
  ))
  gatewayA = new BotGateway({ get: () => undefined }, {
    stateDir: join(root, 'node-a'),
    access: { userIds: ['ou_e2e'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {},
    remoteTransport: {
      enabled: true,
      nodeId: 'node-a',
      sharedSecretEnv: 'DSH_REMOTE_TEST_SECRET',
      routes: { researcher: { nodeId: 'node-b', endpoint: serverB.url, enabled: true } },
    },
    collaboration: { enabled: true, approvalMode: 'never' },
  })
  serverA = await startRemoteServer(SECRET, join(root, 'node-a-inbox.jsonl'), message => (
    gatewayA.receiveRemoteBotMessage(message)
  ))
  gatewayB = new BotGateway({ get: () => undefined }, {
    stateDir: join(root, 'node-b'),
    access: { userIds: ['ou_e2e'] },
    telegram: { enabled: false },
    feishu: { enabled: false },
    profiles: {
      researcher: { capabilities: ['research'], runtimeAdapter: 'hermes' },
    },
    remoteTransport: {
      enabled: true,
      nodeId: 'node-b',
      sharedSecretEnv: 'DSH_REMOTE_TEST_SECRET',
      nodes: { 'node-a': { nodeId: 'node-a', endpoint: serverA.url, enabled: true } },
    },
    collaboration: {
      enabled: true,
      approvalMode: 'never',
      features: { externalRuntimes: true },
      botRunMaxAttempts: 1,
    },
  })
  gatewayBRef = gatewayB
  gatewayB.registerRuntimeAdapter({ kind: 'hermes', run: adapterRun }, true)
  for (const gateway of [gatewayA, gatewayB]) {
    gateway.transports = [{ platform: 'feishu', async start() {}, async stop() {}, async send() {} }]
    gateway.transportByPlatform.set('feishu', gateway.transports[0])
  }
  await gatewayA.start()
  await gatewayB.start()
  return {
    gatewayA,
    gatewayB,
    serverA,
    serverB,
    async stop() {
      await gatewayB.stop()
      await gatewayA.stop()
      await serverA.close()
      await serverB.close()
    },
  }
}

test('external runtime + cross-machine transport: full remote round trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-remote-runtime-e2e-'))
  let setup
  try {
    setup = await twoNodeSetup(root, async input => ({
      requestId: input.requestId,
      status: 'completed',
      text: 'remote-result:' + input.instruction.slice(0, 24),
    }))
    const { gatewayA, gatewayB, serverA, serverB } = setup
    const replyTarget = { platform: 'feishu', chatId: 'oc_e2e', chatType: 'dm', userId: 'ou_e2e' }
    const envelope = await gatewayA.sendBotMessage({
      from: 'user:feishu:ou_e2e',
      to: 'researcher',
      instruction: 'analyze the market data',
      replyTarget,
      idempotencyKey: 'e2e-roundtrip-1',
    })

    let task
    await waitUntil(async () => {
      task = await gatewayA.tasks.task(envelope.taskId)
      return task?.status === 'completed'
    })
    assert.equal(task.status, 'completed')
    assert.match(task.result, /^remote-result:/u)
    assert.ok(task.result.length > 'remote-result:'.length)

    // Node B executed the task through the external runtime adapter.
    const bSnapshot = await gatewayB.tasks.snapshot()
    const researcherRun = bSnapshot.runs.find(run => run.botId === 'researcher')
    assert.ok(researcherRun, 'node B should have created a run for researcher')
    assert.equal(researcherRun.status, 'completed')
    assert.match(String(researcherRun.output ?? ''), /^remote-result:/u)

    // Both transport ledgers observed the round trip.
    assert.equal((await serverB.ledger.snapshot()).length, 1, 'node B inbox saw the delivery')
    assert.equal((await serverA.ledger.snapshot()).length, 1, 'node A inbox saw the result report')
  } finally {
    if (setup) await setup.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('remote round trip reports an adapter failure back to the source node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-remote-runtime-fail-'))
  let setup
  try {
    setup = await twoNodeSetup(root, async input => ({
      requestId: input.requestId,
      status: 'failed',
      text: 'upstream outage for ' + input.botId,
    }))
    const { gatewayA, gatewayB } = setup
    const replyTarget = { platform: 'feishu', chatId: 'oc_e2e', chatType: 'dm', userId: 'ou_e2e' }
    const envelope = await gatewayA.sendBotMessage({
      from: 'user:feishu:ou_e2e',
      to: 'researcher',
      instruction: 'risky query',
      replyTarget,
      idempotencyKey: 'e2e-failure-1',
    })
    let task
    await waitUntil(async () => {
      task = await gatewayA.tasks.task(envelope.taskId)
      return task?.status === 'failed'
    })
    assert.equal(task.status, 'failed')
    assert.match(task.error, /upstream outage for researcher/u)
    const bSnapshot = await gatewayB.tasks.snapshot()
    const researcherRun = bSnapshot.runs.find(run => run.botId === 'researcher')
    assert.equal(researcherRun.status, 'failed')
  } finally {
    if (setup) await setup.stop()
    await rm(root, { recursive: true, force: true })
  }
})
