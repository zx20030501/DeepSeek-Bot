import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HermesRuntimeAdapter,
  RuntimeAdapterError,
  RuntimeAdapterRegistry,
} from '../dist/runtime-adapter.js'

/** JSON-RPC-shaped mock transport; records every request for assertions. */
function mockTransport(responder) {
  const calls = []
  return {
    calls,
    transport: {
      async request(method, params, signal) {
        calls.push({ method, params: params ?? {}, signal: Boolean(signal) })
        return responder(method, params ?? {}, calls.length)
      },
      async close() {},
    },
  }
}

function request(overrides = {}) {
  return {
    requestId: 'req-1',
    botId: 'hermes-bot',
    sessionId: 'session-hermes-1',
    instruction: 'Summarize the quarterly report',
    ...overrides,
  }
}

test('HermesRuntimeAdapter runs a prompt through session.create and prompt.submit', async () => {
  const kit = mockTransport((method) => {
    if (method === 'session.create') return { result: { session_id: 'sess-1' } }
    if (method === 'prompt.submit') return { result: { text: 'the summary' } }
    return {}
  })
  const adapter = new HermesRuntimeAdapter({ transport: kit.transport })
  const result = await adapter.run(request())
  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'the summary')
  assert.equal(kit.calls.length, 2)
  assert.equal(kit.calls[0].method, 'session.create')
  assert.equal(kit.calls[1].method, 'prompt.submit')
  assert.deepEqual(kit.calls[1].params, { session_id: 'sess-1', text: 'Summarize the quarterly report' })
  await adapter.close()
})

test('HermesRuntimeAdapter reuses the remote session across runs', async () => {
  let sessionCreates = 0
  const kit = mockTransport((method) => {
    if (method === 'session.create') {
      sessionCreates += 1
      return { result: { session_id: 'sess-reused' } }
    }
    return { result: { text: 'ok' } }
  })
  const adapter = new HermesRuntimeAdapter({ transport: kit.transport })
  await adapter.run(request())
  await adapter.run(request())
  await adapter.run(request())
  assert.equal(sessionCreates, 1)
  await adapter.close()
})

test('HermesRuntimeAdapter honors a configured remote session id', async () => {
  const kit = mockTransport(() => ({ result: { text: 'ok' } }))
  const adapter = new HermesRuntimeAdapter({ transport: kit.transport })
  const result = await adapter.run(request({ metadata: { hermesSessionId: 'sess-configured' } }))
  assert.equal(result.status, 'completed')
  assert.equal(kit.calls.length, 1)
  assert.equal(kit.calls[0].method, 'prompt.submit')
  assert.equal(kit.calls[0].params.session_id, 'sess-configured')
  await adapter.close()
})

test('HermesRuntimeAdapter maps JSON-RPC errors and missing sessions', async () => {
  const failing = mockTransport(() => ({ error: { message: 'upstream boom' } }))
  const adapter = new HermesRuntimeAdapter({ transport: failing.transport })
  await assert.rejects(() => adapter.run(request()), error => {
    assert.ok(error instanceof RuntimeAdapterError)
    assert.equal(error.code, 'hermes.rpc_error')
    assert.equal(error.retryable, false)
    return true
  })
  await adapter.close()

  const noSession = mockTransport(() => ({}))
  const adapter2 = new HermesRuntimeAdapter({ transport: noSession.transport })
  await assert.rejects(() => adapter2.run(request()), /session\.create did not return a session id/u)
  await adapter2.close()
})

test('RuntimeAdapterRegistry deduplicates kinds and dispatches runs', async () => {
  const kit = mockTransport((method) => (
    method === 'session.create'
      ? { result: { session_id: 'sess-registry' } }
      : { result: { text: 'registry-run' } }
  ))
  const adapter = new HermesRuntimeAdapter({ transport: kit.transport })
  const registry = new RuntimeAdapterRegistry()
  registry.register(adapter)
  assert.throws(() => registry.register(adapter), /already registered/u)
  assert.equal(registry.get('hermes'), adapter)
  const result = await registry.run('hermes', request())
  assert.equal(result.text, 'registry-run')
  assert.throws(() => registry.require('grok'), /No runtime adapter is registered/u)
  await registry.close()
})
