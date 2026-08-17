import test from 'node:test'
import assert from 'node:assert/strict'
import { formatHelp, parseBotCommand, splitText, textFromContent } from '../dist/commands.js'

test('parses local commands without consuming normal prompts', () => {
  assert.deepEqual(parseBotCommand('  /MODEL provider:model  '), {
    name: 'model',
    args: 'provider:model',
  })
  assert.equal(parseBotCommand('please /help me'), undefined)
  assert.equal(parseBotCommand('/'), undefined)
})

test('splits by Unicode code points for platform message limits', () => {
  const chunks = splitText('a😀b😀c', 3)
  assert.deepEqual(chunks, ['a😀b', '😀c'])
  assert.deepEqual(splitText('', 3), [''])
  assert.throws(() => splitText('x', 0), /positive/u)
})

test('extracts only text content blocks and keeps help actionable', () => {
  assert.equal(textFromContent([
    { type: 'text', text: 'hello ' },
    { type: 'image', url: 'ignored' },
    { type: 'text', text: 'world' },
  ]), 'hello world')
  const help = formatHelp()
  assert.match(help, /\/new/u)
  assert.match(help, /未知 \/ 命令/u)
})
