import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuTransport, toFeishuInbound } from '../dist/feishu.js'

function normalizedMessage(overrides = {}) {
  return {
    messageId: 'om_test_message',
    chatId: 'oc_test_chat',
    chatType: 'group',
    senderId: 'ou_test_user',
    content: 'hello from Feishu',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_735_000_000_000,
    raw: { header: { event_id: 'evt_test' } },
    ...overrides,
  }
}

test('normalizes Feishu messages into stable gateway targets', () => {
  const message = toFeishuInbound(normalizedMessage({
    threadId: 'omt_thread',
    replyToMessageId: 'om_parent',
    resources: [{ type: 'file', fileKey: 'file_key', fileName: 'report.pdf' }],
  }))
  assert.equal(message.id, 'feishu:message:om_test_message')
  assert.equal(message.updateId, 'evt_test')
  assert.deepEqual(message.target, {
    platform: 'feishu',
    chatId: 'oc_test_chat',
    threadId: 'omt_thread',
    replyToMessageId: 'om_parent',
    userId: 'ou_test_user',
    chatType: 'group',
  })
  assert.match(message.text, /hello from Feishu/u)
  assert.match(message.text, /report\.pdf/u)
})

test('Feishu transport connects, receives normalized events, and sends markdown', async () => {
  const handlers = new Map()
  const sent = []
  let disconnected = false
  const factory = () => ({
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    async connect() {},
    async disconnect() {
      disconnected = true
    },
    async send(to, input, options) {
      sent.push({ to, input, options })
    },
    getConnectionStatus() {
      return { state: 'open' }
    },
  })
  const transport = new FeishuTransport({ appId: 'cli_test', appSecret: 'secret' }, factory)
  const received = []
  const loop = transport.start(async message => received.push(message))
  await new Promise(resolve => setTimeout(resolve, 0))
  await handlers.get('message')(normalizedMessage({ chatType: 'p2p', mentionedBot: false }))
  await transport.send(
    { platform: 'feishu', chatId: 'oc_test_chat', threadId: 'omt_thread', replyToMessageId: 'om_parent' },
    '**answer**',
  )
  assert.equal(received.length, 1)
  assert.equal(received[0].target.chatType, 'dm')
  assert.deepEqual(sent, [{
    to: 'oc_test_chat',
    input: { markdown: '**answer**' },
    options: { replyTo: 'om_parent', replyInThread: true },
  }])
  await transport.stop()
  await loop
  assert.equal(disconnected, true)
})
