import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamStore } from '../dist/team-store.js'

test('Team Store persists bounded teams and collaboration threads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-team-store-'))
  const file = join(root, 'teams.jsonl')
  try {
    const store = new TeamStore(file)
    const team = await store.createTeam({
      name: 'Research Fleet',
      description: 'Research, verify, and summarize',
      scope: 'user',
      ownerId: 'user:a',
      managerBotId: 'manager',
      memberBotIds: ['manager', 'researcher', 'reviewer'],
      maxConcurrency: 2,
    }, 'user:a', 1_000)
    assert.equal(team.version, 1)
    assert.equal(team.managerBotId, 'manager')
    assert.equal((await store.listTeams({ actorId: 'user:a' })).length, 1)
    assert.equal((await store.listTeams({ actorId: 'user:b' })).length, 0)

    const thread = await store.openThread({
      teamId: team.id,
      createdBy: 'user:a',
      taskId: 'task_1',
      artifacts: [{ kind: 'file', label: 'Requirements', uri: 'artifact://requirements.md' }],
    }, 'user:a', 2_000)
    assert.equal(thread.participantBotIds.length, 3)
    assert.equal(thread.artifacts.length, 1)
    const waiting = await store.updateThread(thread.id, {
      participantBotIds: ['manager', 'researcher'],
      status: 'waiting',
    }, 'user:a', 1, 3_000)
    assert.equal(waiting.version, 2)
    assert.equal(waiting.status, 'waiting')

    const reloaded = new TeamStore(file)
    assert.equal((await reloaded.getTeam(team.id))?.name, 'Research Fleet')
    assert.equal((await reloaded.getThread(thread.id))?.participantBotIds.length, 2)
    assert.deepEqual(reloaded.stats(), {
      schemaVersion: 1,
      teams: 1,
      activeTeams: 1,
      threads: 1,
      openThreads: 1,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Team Store enforces manager membership, concurrency bounds, and optimistic versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-team-validation-'))
  try {
    const store = new TeamStore(join(root, 'teams.jsonl'))
    await assert.rejects(store.createTeam({
      name: 'Invalid', scope: 'user', ownerId: 'user:a', managerBotId: 'boss', memberBotIds: ['worker'],
    }, 'user:a'), /manager must also be/u)
    const team = await store.createTeam({
      name: 'Valid', scope: 'user', ownerId: 'user:a', memberBotIds: ['worker', 'reviewer'], maxConcurrency: 2,
    }, 'user:a')
    await assert.rejects(store.updateTeam(team.id, { maxConcurrency: 3 }, 'user:a', 1), /outside the member bound/u)
    const updated = await store.updateTeam(team.id, { managerBotId: 'worker', status: 'paused' }, 'user:a', 1)
    assert.equal(updated.version, 2)
    assert.equal(updated.status, 'paused')
    await assert.rejects(store.updateTeam(team.id, { name: 'Stale' }, 'user:a', 1), /version conflict/u)
    await assert.rejects(store.updateTeam(team.id, { name: 'Other user' }, 'user:b', 2), /cannot manage/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Team Store rejects credential-bearing artifact references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-team-security-'))
  const file = join(root, 'teams.jsonl')
  try {
    const store = new TeamStore(file)
    const team = await store.createTeam({
      name: 'Safe Team', scope: 'user', ownerId: 'user:a', memberBotIds: ['worker'],
    }, 'user:a')
    const password = ['Password', '123456789'].join('')
    const accessToken = ['fleet', 'access', '0123456789abcdef'].join('-')
    const unsafeUris = [
      `https://example.test/file?token=${accessToken}`,
      `https://example.test/file?access_token=${accessToken}`,
      `https://example.test/file?auth_token=${accessToken}`,
      `https://example.test/file?authToken=${accessToken}`,
      `https://example.test/file?credential=${accessToken}`,
      `https://example.test/file?auth%5Ftoken=${accessToken}`,
      `https://alice:${password}@example.test/private`,
      encodeURIComponent(`https://example.test/file?auth_token=${accessToken}`),
      encodeURIComponent(encodeURIComponent(`https://example.test/file?credential=${accessToken}`)),
      `postgres://alice:${password}@database.example.test/fleet`,
    ]
    for (const uri of unsafeUris) {
      await assert.rejects(store.openThread({
        teamId: team.id,
        createdBy: 'user:a',
        artifacts: [{ kind: 'url', label: 'Unsafe', uri }],
      }, 'user:a'), /credential-bearing URLs/u)
    }
    assert.equal(store.stats().threads, 0)
    const journal = await readFile(file, 'utf8')
    assert.equal(journal.includes(accessToken), false)
    assert.equal(journal.includes(password), false)

    const reloaded = new TeamStore(file)
    assert.equal((await reloaded.listThreads()).length, 0)
    assert.equal(reloaded.stats().threads, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
