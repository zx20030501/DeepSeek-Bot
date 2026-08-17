import test from 'node:test'
import assert from 'node:assert/strict'
import { TelegramTransport } from '../dist/telegram.js'

test('Telegram transport chunks long replies and replies only on the first chunk', async () => {
  const calls = []
  const transport = new TelegramTransport(
    { token: 'test-token', requestTimeoutMs: 1_000 },
    async (_url, init) => {
      calls.push(JSON.parse(String(init.body)))
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({ ok: true, result: true }),
      }
    },
  )
  await transport.send(
    { platform: 'telegram', chatId: '42', threadId: '7', replyToMessageId: '9' },
    'x'.repeat(4_097),
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].message_thread_id, 7)
  assert.deepEqual(calls[0].reply_parameters, { message_id: 9 })
  assert.equal(calls[1].reply_parameters, undefined)
  assert.equal(calls[0].text.length, 4_096)
  assert.equal(calls[1].text.length, 1)
})
