import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeAdapterError,
  XaiGrokRuntimeAdapter,
} from '../dist/runtime-adapter.js'

function mockFetch(responder) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return responder(url, init, calls.length)
    },
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function request(overrides = {}) {
  return {
    requestId: 'req-grok-1',
    botId: 'grok-bot',
    sessionId: 'session-grok-1',
    instruction: 'Explain the strategy',
    ...overrides,
  }
}

test('XaiGrokRuntimeAdapter runs a prompt through the Responses API', async () => {
  const kit = mockFetch(() => jsonResponse({
    id: 'resp-1',
    output_text: 'grok strategy answer',
    usage: { input_tokens: 12, output_tokens: 6 },
  }))
  const adapter = new XaiGrokRuntimeAdapter({
    apiKey: 'test-xai-key',
    fetch: kit.fetch,
    baseUrl: 'https://grok.test/v1',
    model: 'grok-test',
  })
  const result = await adapter.run(request())
  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'grok strategy answer')
  assert.equal(result.responseId, 'resp-1')
  assert.equal(result.usage.inputTokens, 12)
  assert.equal(result.usage.outputTokens, 6)

  assert.equal(kit.calls.length, 1)
  assert.equal(kit.calls[0].url, 'https://grok.test/v1/responses')
  assert.equal(kit.calls[0].init.method, 'POST')
  assert.equal(kit.calls[0].init.headers.authorization, 'Bearer test-xai-key')
  const body = JSON.parse(kit.calls[0].init.body)
  assert.equal(body.model, 'grok-test')
  assert.ok(JSON.stringify(body.input).includes('Explain the strategy'))
  assert.equal(body.store, false)
  await adapter.close()
})

test('XaiGrokRuntimeAdapter maps HTTP errors with retryable status codes', async () => {
  const kit = mockFetch(() => jsonResponse({ error: { message: 'rate limited' } }, 429))
  const adapter = new XaiGrokRuntimeAdapter({ apiKey: 'k', fetch: kit.fetch })
  await assert.rejects(() => adapter.run(request()), error => {
    assert.ok(error instanceof RuntimeAdapterError)
    assert.equal(error.code, 'grok.http_error')
    assert.equal(error.retryable, true)
    assert.equal(error.status, 429)
    return true
  })
  await adapter.close()

  const badRequest = mockFetch(() => jsonResponse({ error: { message: 'bad input' } }, 400))
  const adapter2 = new XaiGrokRuntimeAdapter({ apiKey: 'k', fetch: badRequest.fetch })
  await assert.rejects(() => adapter2.run(request()), error => {
    assert.equal(error.code, 'grok.http_error')
    assert.equal(error.retryable, false)
    return true
  })
  await adapter2.close()
})

test('XaiGrokRuntimeAdapter rejects an empty response and a missing key', async () => {
  const empty = mockFetch(() => jsonResponse({ id: 'resp-2' }))
  const adapter = new XaiGrokRuntimeAdapter({ apiKey: 'k', fetch: empty.fetch })
  await assert.rejects(() => adapter.run(request()), /did not contain output text/u)
  await adapter.close()

  const noKey = new XaiGrokRuntimeAdapter({ fetch: mockFetch(() => jsonResponse({})).fetch })
  await assert.rejects(() => noKey.run(request()), error => {
    assert.ok(error instanceof RuntimeAdapterError)
    assert.equal(error.code, 'grok.api_key_missing')
    return true
  })
})

test('XaiGrokRuntimeAdapter reads the API key from the environment', async () => {
  process.env.DSH_XAI_TEST_KEY = 'env-key'
  const kit = mockFetch(() => jsonResponse({ output_text: 'from env' }))
  const adapter = new XaiGrokRuntimeAdapter({
    apiKeyEnv: 'DSH_XAI_TEST_KEY',
    getEnv: name => process.env[name],
    fetch: kit.fetch,
  })
  const result = await adapter.run(request())
  assert.equal(result.text, 'from env')
  assert.equal(kit.calls[0].init.headers.authorization, 'Bearer env-key')
  delete process.env.DSH_XAI_TEST_KEY
  await adapter.close()
})
