import type { BotDirectory } from './collaboration.js'
import type { TeamStore } from './team-store.js'
import type {
  AgentThread,
  BotRegistryContext,
  BotTarget,
  TeamDefinition,
} from './types.js'

export interface TeamRouteRequest {
  readonly reference: string
  readonly requester: string
  readonly replyTarget: BotTarget
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly maxParticipants?: number
}

export interface TeamRoutePlan {
  readonly team: TeamDefinition
  readonly requester: string
  readonly reference: string
  readonly participantBotIds: readonly string[]
  readonly managerBotId?: string
  readonly blockedBotIds: readonly string[]
  readonly truncatedBotIds: readonly string[]
}

export class TeamRouterError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'TeamRouterError'
  }
}

function normalized(value: string, label: string): string {
  const result = value.trim().toLowerCase()
  if (!result) throw new TeamRouterError('TEAM_REFERENCE_REQUIRED', label + ' is required')
  if (result.length > 200) throw new TeamRouterError('TEAM_REFERENCE_TOO_LONG', label + ' is too long')
  return result
}

function teamSlug(team: TeamDefinition): string {
  return team.name.trim().toLowerCase().replace(/[\s_]+/gu, '-')
}

function isTerminalThread(thread: AgentThread): boolean {
  return thread.status === 'completed' || thread.status === 'cancelled'
}

/**
 * The canonical Team execution boundary. It resolves a visible Team, takes a
 * fresh member/ACL snapshot, and persists one durable AgentThread before the
 * Gateway creates a Task/Run/Room. It never widens membership or ACL.
 */
export class TeamRouter {
  public constructor(
    private readonly teams: TeamStore,
    private readonly directory: BotDirectory,
  ) {}

  public async resolve(input: TeamRouteRequest): Promise<TeamRoutePlan> {
    const reference = normalized(input.reference, 'Team reference')
    const requester = normalized(input.requester, 'Team requester')
    const context: BotRegistryContext = {
      actorId: requester,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    }
    const visible = await this.teams.listTeams(context)
    const matches = visible.filter(team => (
      team.id.toLowerCase() === reference
      || team.name.trim().toLowerCase() === reference
      || teamSlug(team) === reference
    ))
    let team: TeamDefinition | undefined
    if (reference === 'team') {
      const active = visible.filter(candidate => candidate.status === 'active')
      if (active.length !== 1) {
        throw new TeamRouterError(
          active.length === 0 ? 'TEAM_NOT_FOUND' : 'TEAM_REFERENCE_AMBIGUOUS',
          active.length === 0
            ? '当前用户没有可执行的 Team。请先用 /teams 查看可见 Team。'
            : '当前用户有多个 Team，请使用 @team:<team-id> 指定目标 Team。',
        )
      }
      team = active[0]
    } else {
      team = matches.find(candidate => candidate.status === 'active')
    }
    if (team === undefined) {
      throw new TeamRouterError('TEAM_NOT_FOUND', '找不到当前用户可执行的 Team：' + input.reference)
    }
    if (team.status !== 'active') {
      throw new TeamRouterError('TEAM_NOT_ACTIVE', 'Team 当前不可执行：' + team.status)
    }

    const maxParticipants = input.maxParticipants === undefined
      ? 6
      : Math.max(1, Math.min(6, Math.floor(input.maxParticipants)))
    const eligible: string[] = []
    const blocked: string[] = []
    for (const botId of team.memberBotIds) {
      const bot = this.directory.get(botId)
      if (
        bot === undefined
        || !bot.enabled
        || !this.directory.canInvoke(bot.id, input.replyTarget)
        || bot.approvalRequired
      ) {
        blocked.push(botId)
        continue
      }
      eligible.push(bot.id)
    }
    if (eligible.length === 0) {
      throw new TeamRouterError('TEAM_NO_ELIGIBLE_BOTS', 'Team 没有当前用户和聊天都可以执行的 Bot。')
    }

    const ordered = team.managerBotId !== undefined && eligible.includes(team.managerBotId)
      ? [team.managerBotId, ...eligible.filter(botId => botId !== team.managerBotId)]
      : [...eligible]
    const participantBotIds = ordered.slice(0, maxParticipants)
    const truncatedBotIds = ordered.slice(maxParticipants)
    if (participantBotIds.length === 0) {
      throw new TeamRouterError('TEAM_NO_PARTICIPANTS', 'Team 没有可用成员。')
    }
    return {
      team,
      requester,
      reference,
      participantBotIds,
      ...(team.managerBotId !== undefined && participantBotIds.includes(team.managerBotId)
        ? { managerBotId: team.managerBotId }
        : {}),
      blockedBotIds: blocked,
      truncatedBotIds,
    }
  }

  /**
   * Open a thread through the system-owned Router after resolve() has taken
   * the authorization snapshot. The user identity remains the durable creator.
   */
  public async openThread(plan: TeamRoutePlan, taskId: string): Promise<AgentThread> {
    const thread = await this.teams.openThread({
      teamId: plan.team.id,
      createdBy: plan.requester,
      participantBotIds: plan.participantBotIds,
      ...(plan.managerBotId === undefined ? {} : { managerBotId: plan.managerBotId }),
      taskId,
    }, 'system:team-router')
    if (isTerminalThread(thread)) {
      throw new TeamRouterError('TEAM_THREAD_TERMINAL', 'Team Thread unexpectedly opened in a terminal state')
    }
    return thread
  }
}

export function teamMentionHandle(team: TeamDefinition): string {
  return teamSlug(team)
}
