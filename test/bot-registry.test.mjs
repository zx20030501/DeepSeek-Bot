import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry, runtimeProfileFor } from '../dist/bot-registry.js'

test('Bot Registry persists scoped identities, immutable revisions, and lifecycle versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-'))
  const file = join(root, 'bot-registry.jsonl')
  try {
    const registry = new BotRegistry(file)
    const created = await registry.create({
      handle: 'Researcher',
      scope: 'user',
      ownerId: 'user:feishu:ou_a',
      source: 'chat',
      revision: {
        title: 'Research Bot',
        capabilities: ['research', 'research'],
        skills: ['web'],
        fleetRole: 'worker',
      },
    }, 'user:feishu:ou_a', 1_000)
    assert.equal(created.definition.handle, 'researcher')
    assert.equal(created.definition.status, 'draft')
    assert.equal(created.definition.version, 1)
    assert.equal(created.revision.revision, 1)
    assert.deepEqual(created.revision.capabilities, ['research'])

    await assert.rejects(
      registry.revise(created.definition.id, { model: 'deepseek-chat' }, 'user:feishu:ou_b', 1),
      /cannot manage/u,
    )
    const revised = await registry.revise(
      created.definition.id,
      { model: 'deepseek-chat', changeSummary: 'Choose the configured model' },
      'user:feishu:ou_a',
      1,
      2_000,
    )
    assert.equal(revised.definition.version, 2)
    assert.equal(revised.definition.currentRevision, 2)
    assert.equal(revised.revision.model, 'deepseek-chat')
    await assert.rejects(
      registry.revise(created.definition.id, { title: 'stale' }, 'user:feishu:ou_a', 1),
      /version conflict/u,
    )

    const active = await registry.setStatus(created.definition.id, 'active', 'user:feishu:ou_a', 2, 3_000)
    assert.equal(active.definition.version, 3)
    assert.equal(active.definition.currentRevision, 2)
    assert.equal(active.definition.status, 'active')
    assert.equal((await registry.list({ actorId: 'user:feishu:ou_a' })).length, 1)
    assert.equal((await registry.list({ actorId: 'user:feishu:ou_b' })).length, 0)
    assert.equal((await registry.history(created.definition.id)).length, 2)

    const journal = await readFile(file, 'utf8')
    await appendFile(file, `${journal}{"torn":`, 'utf8')
    const reloaded = new BotRegistry(file)
    assert.equal((await reloaded.getByHandle('RESEARCHER'))?.definition.status, 'active')
    assert.equal((await reloaded.get(created.definition.id))?.revision.model, 'deepseek-chat')
    const afterTornTail = await reloaded.create({
      handle: 'writer',
      scope: 'user',
      ownerId: 'user:feishu:ou_a',
      source: 'chat',
      revision: { title: 'Writer Bot' },
    }, 'user:feishu:ou_a', 4_000)
    const afterAppendReload = new BotRegistry(file)
    assert.equal((await afterAppendReload.get(created.definition.id))?.definition.status, 'active')
    assert.equal((await afterAppendReload.get(afterTornTail.definition.id))?.revision.title, 'Writer Bot')
    assert.deepEqual(reloaded.stats(), {
      schemaVersion: 1,
      definitions: 2,
      active: 1,
      drafts: 1,
      disabled: 0,
      deleted: 0,
      revisions: 3,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot Registry rejects credential material and invalid scope bindings before persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-security-'))
  const file = join(root, 'bot-registry.jsonl')
  try {
    const registry = new BotRegistry(file)
    await assert.rejects(registry.create({
      handle: 'unsafe',
      scope: 'user',
      ownerId: 'user:a',
      revision: { title: 'Unsafe', soul: `Use key ${'sk-' + 'x'.repeat(32)}` },
    }, 'user:a'), /cannot contain API keys/u)
    const credentialDrafts = [
      { title: `Authorization: Bearer ${'a'.repeat(32)}` },
      { title: 'URL token', description: `https://example.test/run?token=${'b'.repeat(24)}` },
      { title: 'GitHub token', soul: `Use ghp_${'c'.repeat(36)}` },
      { title: 'AWS token', capabilities: [`AKIA${'D'.repeat(16)}`] },
      { title: `Encoded Authorization%3A%20Bearer%20${'e'.repeat(32)}` },
      { title: 'Unsafe model URL', model: `https://example.test/v1?token=${'f'.repeat(24)}` },
    ]
    for (const [index, revision] of credentialDrafts.entries()) {
      await assert.rejects(registry.create({
        handle: `unsafe-${index}`,
        scope: 'user',
        ownerId: 'user:a',
        revision,
      }, 'user:a'), /credential|API keys|configured identifier|URL/iu)
    }
    const extendedCredentialProbes = [
      `token: ${'t'.repeat(32)}`,
      `secret = ${'s'.repeat(32)}`,
      'https://alice:Password123456@example.test/path',
      `Use glpat-${'g'.repeat(32)}`,
      `https://example.test/path?auth_token=${'h'.repeat(32)}`,
      `https://example.test/path?authToken=${'i'.repeat(32)}`,
      `https://example.test/path?credential=${'j'.repeat(32)}`,
      encodeURIComponent(`https://example.test/path?auth_token=${'k'.repeat(32)}`),
      encodeURIComponent(encodeURIComponent(`https://example.test/path?credential=${'l'.repeat(32)}`)),
    ]
    const freeTextFields = ['title', 'description', 'soul', 'capabilities', 'skills']
    for (const [probeIndex, probe] of extendedCredentialProbes.entries()) {
      for (const [fieldIndex, field] of freeTextFields.entries()) {
        const revision = { title: 'Safe title' }
        if (field === 'capabilities' || field === 'skills') revision[field] = [probe]
        else revision[field] = probe
        await assert.rejects(registry.create({
          handle: `unsafe-extra-${probeIndex}-${fieldIndex}`,
          scope: 'user',
          ownerId: 'user:a',
          revision,
        }, 'user:a'), /credential|API keys/iu)
      }
    }
    await assert.rejects(registry.create({
      handle: 'workspace-bot',
      scope: 'workspace',
      ownerId: 'user:a',
      revision: { title: 'Workspace Bot' },
    }, 'user:a'), /requires workspaceId/u)
    await assert.rejects(registry.create({
      handle: 'other-owner',
      scope: 'user',
      ownerId: 'user:b',
      revision: { title: 'Other owner' },
    }, 'user:a'), /cannot create/u)
    assert.equal(registry.stats().definitions, 0)
    await assert.rejects(readFile(file, 'utf8'), error => error?.code === 'ENOENT')
    const reloaded = new BotRegistry(file)
    assert.equal((await reloaded.list(undefined, true)).length, 0)
    assert.equal(reloaded.stats().definitions, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('static profile migration is idempotent and preserves disabled profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-migration-'))
  try {
    const registry = new BotRegistry(join(root, 'bot-registry.jsonl'))
    const profiles = [
      { name: 'researcher', title: 'Researcher', fleetRole: 'worker', capabilities: ['research'] },
      { name: 'legacy-off', title: 'Legacy Off', enabled: false },
    ]
    const first = await registry.seedStaticProfiles(profiles, 1_000)
    const second = await registry.seedStaticProfiles(profiles, 2_000)
    assert.equal(first.length, 2)
    assert.equal(second.length, 2)
    assert.equal(registry.stats().revisions, 2)
    assert.equal((await registry.getByHandle('legacy-off'))?.definition.status, 'disabled')

    await registry.seedStaticProfiles([{ ...profiles[0], title: 'Research Lead' }, profiles[1]], 3_000)
    assert.equal(registry.stats().revisions, 3)
    assert.equal((await registry.getByHandle('researcher'))?.revision.title, 'Research Lead')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('static profile migration cannot reuse dynamic or tombstoned handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-namespace-'))
  try {
    const registry = new BotRegistry(join(root, 'bot-registry.jsonl'))
    await registry.create({
      handle: 'dynamic-live', scope: 'user', ownerId: 'user:feishu:ou_a', source: 'chat',
      revision: { title: 'Dynamic Live' },
    }, 'user:feishu:ou_a')
    await assert.rejects(
      registry.seedStaticProfiles([{ name: 'dynamic-live', title: 'Static Collision' }]),
      /reserved|tombstone/u,
    )
    const tombstone = await registry.create({
      handle: 'dynamic-deleted', scope: 'user', ownerId: 'user:feishu:ou_a', source: 'chat',
      revision: { title: 'Deleted Dynamic' },
    }, 'user:feishu:ou_a')
    await registry.setStatus(tombstone.definition.id, 'deleted', 'user:feishu:ou_a', tombstone.definition.version)
    await assert.rejects(
      registry.seedStaticProfiles([{ name: 'dynamic-deleted', title: 'Static Tombstone Reuse' }]),
      /reserved|tombstone/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Bot Registry optimistic versioning serializes concurrent edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-concurrency-'))
  try {
    const registry = new BotRegistry(join(root, 'bot-registry.jsonl'))
    const bot = await registry.create({
      handle: 'writer', scope: 'user', ownerId: 'user:a', revision: { title: 'Writer' },
    }, 'user:a')
    const results = await Promise.allSettled([
      registry.revise(bot.definition.id, { title: 'Writer A' }, 'user:a', 1),
      registry.revise(bot.definition.id, { title: 'Writer B' }, 'user:a', 1),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal((await registry.history(bot.definition.id)).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime projection exposes only active scopes that can be enforced by the current gateway ACL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-registry-projection-'))
  try {
    const registry = new BotRegistry(join(root, 'bot-registry.jsonl'))
    const userBot = await registry.create({
      handle: 'private-worker',
      scope: 'user',
      ownerId: 'user:feishu:ou_owner',
      status: 'active',
      revision: {
        title: 'Private Worker',
        fleetRole: 'worker',
        allowedUserIds: ['ou_owner'],
      },
    }, 'user:feishu:ou_owner')
    assert.deepEqual(runtimeProfileFor(userBot)?.allowedUserIds, [])
    assert.deepEqual(runtimeProfileFor(userBot)?.allowedPrincipals, ['user:feishu:ou_owner'])

    const normalizedUserBot = await registry.create({
      handle: 'owner-acl',
      scope: 'user',
      ownerId: 'user:feishu:ou_owner',
      status: 'active',
      revision: { title: 'Owner ACL', allowedUserIds: ['ou_other'], allowedChatIds: ['oc_other'] },
    }, 'user:feishu:ou_owner')
    assert.deepEqual(runtimeProfileFor(normalizedUserBot)?.allowedUserIds, [])
    assert.deepEqual(runtimeProfileFor(normalizedUserBot)?.allowedPrincipals, ['user:feishu:ou_owner'])
    assert.deepEqual(runtimeProfileFor(normalizedUserBot)?.allowedChatIds, [])

    const sessionBot = await registry.create({
      handle: 'session-only',
      scope: 'session',
      ownerId: 'user:feishu:ou_owner',
      sessionId: 'session-a',
      status: 'active',
      revision: { title: 'Session Bot', allowedUserIds: ['ou_owner'] },
    }, 'user:feishu:ou_owner')
    assert.equal(runtimeProfileFor(sessionBot), undefined)

    const manager = await registry.create({
      handle: 'manager-later',
      scope: 'user',
      ownerId: 'user:feishu:ou_owner',
      status: 'active',
      revision: { title: 'Manager', fleetRole: 'manager', allowedUserIds: ['ou_owner'] },
    }, 'user:feishu:ou_owner')
    assert.equal(runtimeProfileFor(manager), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
