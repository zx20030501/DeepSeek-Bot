import assert from 'node:assert/strict'
import test from 'node:test'
import { MentionParserError, parseFleetMentions } from '../dist/mention-parser.js'

test('parses ordered Bot mentions, removes duplicates, and preserves instruction text', () => {
  const result = parseFleetMentions('请让 @researcher 和 @writer 分析；然后再次提醒 @researcher。', {
    knownBots: ['researcher', 'writer'],
  })
  assert.deepEqual(result.targets.map(target => target.id), ['researcher', 'writer'])
  assert.deepEqual(result.routableTargets.map(target => target.id), ['researcher', 'writer'])
  assert.equal(result.unknownTargets.length, 0)
  assert.match(result.instruction, /请让/u)
  assert.match(result.instruction, /分析/u)
  assert.equal(result.metadata.truncated, false)
})

test('recognizes Team and Manager prefixes and reports unknown Bot targets', () => {
  const result = parseFleetMentions('@researcher @unknown @team:research @manager:lead 请规划', {
    knownBots: ['researcher'],
    knownTeams: ['research'],
    managerIds: ['lead'],
  })
  assert.deepEqual(result.targets.map(target => `${target.kind}:${target.id}`), [
    'bot:researcher',
    'bot:unknown',
    'team:research',
    'manager:lead',
  ])
  assert.deepEqual(result.unknownTargets.map(target => target.id), ['unknown'])
  assert.deepEqual(result.routableTargets.map(target => target.kind), ['bot', 'team', 'manager'])
})

test('ignores e-mail, URLs, Markdown links, inline code and fenced code', () => {
  const text = [
    '联系 a@researcher.example',
    '打开 https://example.test/@writer/path',
    '看这个 [@linked](https://example.test)',
    '`@inline`',
    '```\n@fenced\n```',
    '真正任务交给 @researcher。',
  ].join('\n')
  const result = parseFleetMentions(text, { knownBots: ['researcher', 'writer', 'linked', 'inline', 'fenced'] })
  assert.deepEqual(result.targets.map(target => target.id), ['researcher'])
  assert.match(result.instruction, /a@researcher\.example/u)
  assert.match(result.instruction, /@inline/u)
  assert.match(result.instruction, /@fenced/u)
})

test('records self, visited, hop and mention budget metadata without performing routing', () => {
  const result = parseFleetMentions('@self @researcher @writer 请协作', {
    knownBots: ['self', 'researcher', 'writer'],
    selfId: 'self',
    visited: ['bot:researcher'],
    hop: 1,
    maxHop: 2,
    mentionBudget: 3,
  })
  assert.equal(result.targets.find(target => target.id === 'self')?.self, true)
  assert.deepEqual(result.routableTargets.map(target => target.id), ['writer'])
  assert.equal(result.metadata.hop, 1)
  assert.deepEqual(result.metadata.visited, ['bot:researcher'])
  assert.equal(result.metadata.remainingMentionBudget, 0)
})

test('deduplicates before applying the target limit and truncates overflow', () => {
  const result = parseFleetMentions('@a @a @b @c task', {
    knownBots: ['a', 'b', 'c'],
    maxTargets: 2,
  })
  assert.deepEqual(result.targets.map(target => target.id), ['a', 'b'])
  assert.equal(result.metadata.truncated, true)
  const duplicateOnly = parseFleetMentions('@a @a task', { knownBots: ['a'], maxTargets: 1 })
  assert.equal(duplicateOnly.metadata.truncated, false)
})

test('handles 500 logical Bot mentions and rejects maliciously long input', () => {
  const ids = Array.from({ length: 500 }, (_, index) => `bot-${index}`)
  const result = parseFleetMentions(ids.map(id => `@${id}`).join(' '), {
    knownBots: ids,
    maxTargets: 500,
    mentionBudget: 500,
  })
  assert.equal(result.targets.length, 500)
  assert.equal(result.routableTargets.length, 500)
  assert.throws(
    () => parseFleetMentions('x'.repeat(100_001)),
    error => error instanceof MentionParserError && error.code === 'MENTION_INPUT_TOO_LARGE',
  )
})

test('stops routing when hop exceeds the configured maximum', () => {
  const result = parseFleetMentions('@researcher continue', { knownBots: ['researcher'], hop: 9, maxHop: 8 })
  assert.equal(result.targets.length, 0)
  assert.equal(result.metadata.truncated, true)
  assert.match(result.metadata.diagnostic ?? '', /maxHop/u)
})
