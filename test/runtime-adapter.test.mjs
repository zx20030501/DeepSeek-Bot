import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GrokRuntimeAdapter,
  HermesRuntimeAdapter,
  RuntimeAdapterError,
  RuntimeAdapterRegistry,
} from '../dist/runtime-adapter.js'

function request(overrides = {}) {
  return {
    requestId: 'request-1',
    botId: 'researcher',
    sessionId: 'session-1',
    instruction: 'Summarize the result',
    ...overrides,
  }
}

test('Grok adapter calls the xAI Responses API and normalizes usage', async () => {
  let received
  const adapter = new GrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    model: 'grok-test',
    fetch: async (url, init) => {
      received = { url: String(url), init }
      return new Response(JSON.stringify({
        id: 'resp-1',
        output_text: 'A concise result',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          cost_in_usd_ticks: 1234,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await adapter.run(request({ systemPrompt: 'Be concise' }))
  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'A concise result')
  assert.equal(result.responseId, 'resp-1')
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    costUsdTicks: 1234,
  })
  assert.equal(received.url, 'https://api.x.ai/v1/responses')
  assert.equal(received.init.headers.authorization, 'Bearer test-xai-key')
  assert.deepEqual(JSON.parse(received.init.body), {
    model: 'grok-test',
    input: [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Summarize the result' },
    ],
    store: false,
  })
})

test('Grok adapter does not require a real key in tests and classifies provider errors', async () => {
  const missing = new GrokRuntimeAdapter({ getEnv: () => undefined })
  await assert.rejects(
    () => missing.run(request({ requestId: 'missing-key' })),
    error => error instanceof RuntimeAdapterError && error.code === 'grok.api_key_missing',
  )

  const rateLimited = new GrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    fetch: async () => new Response(JSON.stringify({
      error: { message: 'slow down' },
    }), { status: 429 }),
  })
  await assert.rejects(
    () => rateLimited.run(request({ requestId: 'rate-limited' })),
    error => (
      error instanceof RuntimeAdapterError
      && error.code === 'grok.http_error'
      && error.retryable
      && error.status === 429
    ),
  )
})

test('Grok adapter cancellation aborts an in-flight request', async () => {
  const adapter = new GrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    fetch: async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const running = adapter.run(request({ requestId: 'cancel-me' }))
  await adapter.cancel('cancel-me')
  const result = await running
  assert.equal(result.status, 'cancelled')
})

test('Grok adapter returns structured function calls instead of misclassifying them as empty output', async () => {
  const adapter = new GrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    fetch: async () => new Response(JSON.stringify({
      id: 'resp-tool',
      output: [{
        type: 'function_call',
        id: 'call-1',
        name: 'search_docs',
        arguments: '{"query":"Fleet"}',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const result = await adapter.run(request({ requestId: 'tool-call' }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.toolCalls, [{ name: 'search_docs', arguments: { query: 'Fleet' }, callId: 'call-1' }])
  assert.match(result.text, /search_docs/u)
})

test('Grok adapter classifies an abort while reading the response body as a timeout', async () => {
  const adapter = new GrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    timeoutMs: 10,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })
      }),
    }),
  })
  await assert.rejects(
    () => adapter.run(request({ requestId: 'body-timeout' })),
    error => error instanceof RuntimeAdapterError && error.code === 'grok.timeout',
  )
})

class FakeHermesTransport {
  constructor() {
    this.listeners = new Set()
    this.sessionCreates = 0
    this.prompts = 0
  }

  async request(method, params) {
    if (method === 'session.create') {
      this.sessionCreates += 1
      return { result: { session_id: 'hermes-session-1' } }
    }
    if (method === 'prompt.submit') {
      this.prompts += 1
      queueMicrotask(() => {
        for (const listener of this.listeners) {
          listener({
            method: 'event',
            params: {
              type: 'message.delta',
              session_id: params.session_id,
              payload: { text: 'Hermes result' },
            },
          })
          listener({
            method: 'event',
            params: {
              type: 'message.complete',
              session_id: params.session_id,
              payload: {},
            },
          })
        }
      })
      return { result: { accepted: true } }
    }
    throw new Error('unexpected method: ' + method)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

test('Hermes adapter uses the public JSON-RPC session and prompt boundary', async () => {
  const transport = new FakeHermesTransport()
  const adapter = new HermesRuntimeAdapter({ transport, timeoutMs: 2_000 })
  const [first, second] = await Promise.all([
    adapter.run(request({ requestId: 'hermes-1' })),
    adapter.run(request({ requestId: 'hermes-2', instruction: 'Follow up' })),
  ])
  assert.equal(first.text, 'Hermes result')
  assert.equal(second.text, 'Hermes result')
  assert.equal(transport.sessionCreates, 1)
  assert.equal(transport.prompts, 2)
})

test('runtime adapter registry rejects accidental duplicate providers', async () => {
  const registry = new RuntimeAdapterRegistry()
  const first = new GrokRuntimeAdapter({ apiKey: 'one' })
  const second = new GrokRuntimeAdapter({ apiKey: 'two' })
  registry.register(first)
  assert.throws(
    () => registry.register(second),
    error => error instanceof RuntimeAdapterError && error.code === 'runtime.adapter_duplicate',
  )
  await registry.close()
})
