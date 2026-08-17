import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotGateway } from '../dist/gateway.js'
import { PairingStore } from '../dist/pairing.js'

test('pairing creates a bounded one-time code and approves the bound sender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-hermes-pairing-'))
  try {
    const store = new PairingStore(join(directory, 'pairing.json'))
    const target = { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_user' }
    const first = await store.request(target, 1_000)
    assert.equal(first?.shouldNotify, true)
    assert.match(first?.request.code ?? '', /^[A-Z2-9]{8}$/u)
    assert.equal(first?.request.code.includes('0'), false)
    assert.equal(first?.request.code.includes('1'), false)

    const repeated = await store.request(target, 2_000)
    assert.equal(repeated?.request.code, first?.request.code)
    assert.equal(repeated?.shouldNotify, false)

    const approved = await store.approve(first.request.code, 3_000)
    assert.equal(approved?.userId, 'ou_user')
    assert.equal(await store.isApproved('feishu', 'ou_user'), true)
    assert.equal(await store.approve(first.request.code, 4_000), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pairing ignores group messages and expires pending requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-hermes-pairing-'))
  try {
    const store = new PairingStore(join(directory, 'pairing.json'))
    assert.equal(await store.request({ platform: 'feishu', chatId: 'oc_group', chatType: 'group', userId: 'ou_user' }), undefined)
    const request = await store.request({ platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_user' }, 1_000)
    assert.equal(await store.approve(request.request.code, request.request.expiresAt + 1), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('gateway replies through pairing state without dispatching an unknown DM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-hermes-pairing-'))
  const gateway = new BotGateway({}, {
    enabled: true,
    stateDir: directory,
    access: { mode: 'allowlist', pairing: true },
    feishu: { enabled: false },
  })
  try {
    await gateway.start()
    await gateway.acceptInbound({
      id: 'feishu:message:pairing-test',
      target: { platform: 'feishu', chatId: 'oc_chat', chatType: 'dm', userId: 'ou_unknown' },
      text: '你好',
      receivedAt: Date.now(),
    })
    const status = gateway.status()
    assert.equal(status.inbound.accepted, 0)
    assert.equal(status.pairing.pending.length, 1)
    const code = status.pairing.pending[0].code
    const candidate = await gateway.approvePairing(code)
    assert.equal(candidate.userId, 'ou_unknown')
    assert.equal(await gateway.revokePairing('feishu', 'ou_unknown'), true)
  } finally {
    await gateway.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
