import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotDirectory } from '../dist/collaboration.js'
import { TeamRouter } from '../dist/team-router.js'
import { TeamStore } from '../dist/team-store.js'

test('TeamRouter resolves one visible Team, preserves ACL, and opens a durable Thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-bot-team-router-'))
  try {
    const requester = 'user:feishu:ou_team'
    const target = { platform: 'feishu', chatId: 'oc_team', chatType: 'dm', userId: 'ou_team' }
    const directory = new BotDirectory([
      { name: 'researcher', title: 'Researcher', capabilities: ['research'], allowedUserIds: ['ou_team'] },
      { name: 'reviewer', title: 'Reviewer', capabilities: ['review'], allowedUserIds: ['ou_team'] },
      { name: 'private', title: 'Private', capabilities: ['private'], allowedUserIds: ['ou_other'] },
    ])
    const teams = new TeamStore(join(root, 'teams.jsonl'))
    const team = await teams.createTeam({
      name: 'Research Team',
      scope: 'user',
      ownerId: requester,
      memberBotIds: ['researcher', 'reviewer', 'private'],
      managerBotId: 'reviewer',
    }, requester)
    const router = new TeamRouter(teams, directory)
    const route = await router.resolve({
      reference: 'team',
      requester,
      replyTarget: target,
      sessionId: 'session-1',
    })
    assert.equal(route.team.id, team.id)
    assert.deepEqual(route.participantBotIds, ['reviewer', 'researcher'])
    assert.deepEqual(route.blockedBotIds, ['private'])
    const thread = await router.openThread(route, 'task-team-1')
    assert.equal(thread.teamId, team.id)
    assert.equal(thread.taskId, 'task-team-1')
    assert.equal(thread.contextId.length > 0, true)
    assert.deepEqual(thread.participantBotIds, ['reviewer', 'researcher'])
    await assert.rejects(() => router.resolve({
      reference: team.id,
      requester: 'user:feishu:ou_other',
      replyTarget: { ...target, userId: 'ou_other' },
    }), /找不到当前用户可执行的 Team/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
