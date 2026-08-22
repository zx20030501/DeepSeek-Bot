import { randomUUID } from 'node:crypto'
import { assertNoCredentialMaterial } from './credential-scan.js'
import { JsonlJournal } from './jsonl.js'
import type {
  AgentThread,
  AgentThreadStatus,
  ArtifactReference,
  ArtifactReferenceKind,
  BotDefinitionScope,
  BotRegistryContext,
  TeamDefinition,
  TeamStatus,
} from './types.js'

const SCHEMA_VERSION = 1 as const
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u

export interface CreateTeamInput {
  readonly name: string
  readonly description?: string
  readonly scope: BotDefinitionScope
  readonly ownerId: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly managerBotId?: string
  readonly memberBotIds: readonly string[]
  readonly maxConcurrency?: number
}

export interface UpdateTeamInput {
  readonly name?: string
  readonly description?: string | null
  readonly managerBotId?: string | null
  readonly memberBotIds?: readonly string[]
  readonly maxConcurrency?: number
  readonly status?: TeamStatus
}

export interface CreateAgentThreadInput {
  readonly teamId: string
  readonly createdBy: string
  readonly participantBotIds?: readonly string[]
  readonly managerBotId?: string
  readonly taskId?: string
  readonly artifacts?: readonly Omit<ArtifactReference, 'id' | 'createdAt'>[]
}

export interface UpdateAgentThreadInput {
  readonly participantBotIds?: readonly string[]
  readonly managerBotId?: string | null
  readonly taskId?: string | null
  readonly artifacts?: readonly Omit<ArtifactReference, 'id' | 'createdAt'>[]
  readonly status?: AgentThreadStatus
}

export interface TeamStoreStats {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly teams: number
  readonly activeTeams: number
  readonly threads: number
  readonly openThreads: number
}

type TeamStoreEvent = {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly eventId: string
  readonly at: number
  readonly actor: string
} & ({
  readonly kind: 'team.saved'
  readonly team: TeamDefinition
} | {
  readonly kind: 'thread.saved'
  readonly thread: AgentThread
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} is too long`)
  return normalized
}

function optionalText(value: string | undefined | null, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maximum) throw new Error('Team field is too long')
  return normalized
}

function botIds(values: readonly string[]): string[] {
  const result = [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))]
  if (result.length < 1 || result.length > 6) throw new Error('A Team must contain between 1 and 6 Bots')
  if (result.some(value => !BOT_ID_PATTERN.test(value))) throw new Error('Team contains an invalid Bot handle')
  return result
}

function managerFor(value: string | undefined | null, members: readonly string[]): string | undefined {
  const manager = optionalText(value, 64)?.toLowerCase()
  if (manager !== undefined && !members.includes(manager)) throw new Error('Team manager must also be a Team member')
  return manager
}

function isScope(value: unknown): value is BotDefinitionScope {
  return value === 'session' || value === 'user' || value === 'workspace' || value === 'shared'
}

function isTeamStatus(value: unknown): value is TeamStatus {
  return value === 'active' || value === 'paused' || value === 'disabled' || value === 'deleted'
}

function isThreadStatus(value: unknown): value is AgentThreadStatus {
  return value === 'open' || value === 'waiting' || value === 'completed' || value === 'cancelled'
}

function visibleTo(team: TeamDefinition, context: BotRegistryContext): boolean {
  if (team.scope === 'shared') return true
  if (team.scope === 'workspace') return team.workspaceId !== undefined && team.workspaceId === context.workspaceId
  if (team.scope === 'session') return team.ownerId === context.actorId && team.sessionId !== undefined && team.sessionId === context.sessionId
  return team.ownerId === context.actorId
}

function canManage(ownerId: string, actor: string): boolean {
  return actor === ownerId || actor === 'local-dashboard' || actor.startsWith('system:')
}

function artifact(input: Omit<ArtifactReference, 'id' | 'createdAt'>, at: number): ArtifactReference {
  assertNoCredentialMaterial(input, 'Team state cannot contain API keys or credential-bearing URLs')
  const kind = input.kind
  if (kind !== 'file' && kind !== 'url' && kind !== 'message' && kind !== 'text') throw new Error('Unsupported artifact kind')
  const label = requiredText(input.label, 'Artifact label', 160)
  const uri = requiredText(input.uri, 'Artifact URI', 2_000)
  const mimeType = optionalText(input.mimeType, 160)
  const sha256 = optionalText(input.sha256, 64)?.toLowerCase()
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Artifact sha256 must contain 64 hexadecimal characters')
  return {
    id: randomUUID(),
    kind: kind as ArtifactReferenceKind,
    label,
    uri,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sha256 === undefined ? {} : { sha256 }),
    createdAt: at,
  }
}

function isTeam(value: unknown): value is TeamDefinition {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<TeamDefinition>
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && isScope(item.scope)
    && typeof item.ownerId === 'string'
    && Array.isArray(item.memberBotIds)
    && isTeamStatus(item.status)
    && typeof item.version === 'number'
    && typeof item.maxConcurrency === 'number'
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number'
}

function isThread(value: unknown): value is AgentThread {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<AgentThread>
  return typeof item.id === 'string'
    && typeof item.contextId === 'string'
    && typeof item.teamId === 'string'
    && typeof item.createdBy === 'string'
    && Array.isArray(item.participantBotIds)
    && Array.isArray(item.artifacts)
    && isThreadStatus(item.status)
    && typeof item.version === 'number'
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number'
}

function sameTeamIdentity(left: TeamDefinition, right: TeamDefinition): boolean {
  return left.id === right.id
    && left.scope === right.scope
    && left.ownerId === right.ownerId
    && left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.createdAt === right.createdAt
}

function sameThreadIdentity(left: AgentThread, right: AgentThread): boolean {
  return left.id === right.id
    && left.contextId === right.contextId
    && left.teamId === right.teamId
    && left.createdBy === right.createdBy
    && left.createdAt === right.createdAt
}

function validTeamShape(team: TeamDefinition): boolean {
  const members = [...new Set(team.memberBotIds)]
  return members.length >= 1
    && members.length <= 6
    && members.length === team.memberBotIds.length
    && members.every(id => BOT_ID_PATTERN.test(id))
    && (team.managerBotId === undefined || members.includes(team.managerBotId))
    && (team.scope !== 'workspace' || typeof team.workspaceId === 'string')
    && (team.scope !== 'session' || typeof team.sessionId === 'string')
    && Number.isInteger(team.maxConcurrency)
    && team.maxConcurrency >= 1
    && team.maxConcurrency <= members.length
}

/** Append-only Team and collaboration-thread state for Fleet v2. */
export class TeamStore {
  private readonly journal: JsonlJournal<TeamStoreEvent>
  private readonly teams = new Map<string, TeamDefinition>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly eventIds = new Set<string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  public constructor(file: string) {
    this.journal = new JsonlJournal<TeamStoreEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    if (this.loading === undefined) {
      this.loading = (async () => {
        for (const event of await this.journal.read()) this.apply(event)
        this.loaded = true
      })()
    }
    await this.loading
  }

  public stats(): TeamStoreStats {
    return {
      schemaVersion: SCHEMA_VERSION,
      teams: this.teams.size,
      activeTeams: [...this.teams.values()].filter(team => team.status === 'active').length,
      threads: this.threads.size,
      openThreads: [...this.threads.values()].filter(thread => thread.status === 'open' || thread.status === 'waiting').length,
    }
  }

  public async createTeam(input: CreateTeamInput, actor: string, at = Date.now()): Promise<TeamDefinition> {
    await this.load()
    return this.mutate(async () => {
      const ownerId = requiredText(input.ownerId, 'Team owner', 256)
      if (!canManage(ownerId, actor)) throw new Error('Actor cannot create a Team for this owner')
      if (!isScope(input.scope)) throw new Error('Unsupported Team scope')
      const workspaceId = optionalText(input.workspaceId, 256)
      const sessionId = optionalText(input.sessionId, 256)
      if (input.scope === 'workspace' && workspaceId === undefined) throw new Error('workspace scope requires workspaceId')
      if (input.scope === 'session' && sessionId === undefined) throw new Error('session scope requires sessionId')
      const members = botIds(input.memberBotIds)
      const managerBotId = managerFor(input.managerBotId, members)
      const description = optionalText(input.description, 2_000)
      const maxConcurrency = input.maxConcurrency ?? Math.min(3, members.length)
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > Math.min(6, members.length)) {
        throw new Error('Team maxConcurrency is outside the member bound')
      }
      const team: TeamDefinition = {
        id: randomUUID(),
        name: requiredText(input.name, 'Team name', 120),
        ...(description === undefined ? {} : { description }),
        scope: input.scope,
        ownerId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(managerBotId === undefined ? {} : { managerBotId }),
        memberBotIds: members,
        maxConcurrency,
        status: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      await this.commit({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), kind: 'team.saved', at, actor, team })
      return clone(team)
    })
  }

  public async updateTeam(
    teamId: string,
    patch: UpdateTeamInput,
    actor: string,
    expectedVersion: number,
    at = Date.now(),
  ): Promise<TeamDefinition> {
    await this.load()
    return this.mutate(async () => {
      const current = this.requireTeam(teamId)
      if (!canManage(current.ownerId, actor)) throw new Error('Actor cannot manage this Team')
      if (current.status === 'deleted') throw new Error('Deleted Teams cannot be changed')
      if (current.version !== expectedVersion) throw new Error('Team version conflict')
      const members = patch.memberBotIds === undefined ? [...current.memberBotIds] : botIds(patch.memberBotIds)
      const managerBotId = Object.hasOwn(patch, 'managerBotId')
        ? managerFor(patch.managerBotId, members)
        : managerFor(current.managerBotId, members)
      const maxConcurrency = patch.maxConcurrency ?? Math.min(current.maxConcurrency, members.length)
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > Math.min(6, members.length)) {
        throw new Error('Team maxConcurrency is outside the member bound')
      }
      const status = patch.status ?? current.status
      if (!isTeamStatus(status)) throw new Error('Unsupported Team status')
      const description = Object.hasOwn(patch, 'description') ? optionalText(patch.description, 2_000) : current.description
      const { description: _oldDescription, managerBotId: _oldManagerBotId, ...teamBase } = current
      const team: TeamDefinition = {
        ...teamBase,
        name: patch.name === undefined ? current.name : requiredText(patch.name, 'Team name', 120),
        ...(description === undefined ? {} : { description }),
        ...(managerBotId === undefined ? {} : { managerBotId }),
        memberBotIds: members,
        maxConcurrency,
        status,
        version: current.version + 1,
        updatedAt: at,
      }
      await this.commit({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), kind: 'team.saved', at, actor, team })
      return clone(team)
    })
  }

  public async getTeam(teamId: string): Promise<TeamDefinition | undefined> {
    await this.load()
    const team = this.teams.get(teamId)
    return team === undefined ? undefined : clone(team)
  }

  public async listTeams(context?: BotRegistryContext, includeDeleted = false): Promise<TeamDefinition[]> {
    await this.load()
    return [...this.teams.values()]
      .filter(team => includeDeleted || team.status !== 'deleted')
      .filter(team => context === undefined || visibleTo(team, context))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  public async openThread(input: CreateAgentThreadInput, actor: string, at = Date.now()): Promise<AgentThread> {
    await this.load()
    return this.mutate(async () => {
      const team = this.requireTeam(input.teamId)
      if (team.status !== 'active') throw new Error('Team is not active')
      const createdBy = requiredText(input.createdBy, 'Thread creator', 256)
      if (!canManage(team.ownerId, actor)) throw new Error('Actor cannot open this Team thread')
      if (createdBy !== actor && actor !== 'local-dashboard' && !actor.startsWith('system:')) {
        throw new Error('Actor cannot create a Team thread for another identity')
      }
      const participants = input.participantBotIds === undefined ? [...team.memberBotIds] : botIds(input.participantBotIds)
      if (participants.some(id => !team.memberBotIds.includes(id))) throw new Error('Thread participant is not a Team member')
      const managerBotId = managerFor(input.managerBotId ?? team.managerBotId, participants)
      const artifacts = (input.artifacts ?? []).map(item => artifact(item, at))
      const taskId = optionalText(input.taskId, 256)
      if (artifacts.length > 50) throw new Error('Thread has too many artifacts')
      const thread: AgentThread = {
        id: randomUUID(),
        contextId: randomUUID(),
        teamId: team.id,
        createdBy,
        participantBotIds: participants,
        ...(managerBotId === undefined ? {} : { managerBotId }),
        ...(taskId === undefined ? {} : { taskId }),
        artifacts,
        status: 'open',
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      await this.commit({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), kind: 'thread.saved', at, actor, thread })
      return clone(thread)
    })
  }

  public async updateThread(
    threadId: string,
    patch: UpdateAgentThreadInput,
    actor: string,
    expectedVersion: number,
    at = Date.now(),
  ): Promise<AgentThread> {
    await this.load()
    return this.mutate(async () => {
      const current = this.requireThread(threadId)
      const team = this.requireTeam(current.teamId)
      if (!canManage(team.ownerId, actor) && current.createdBy !== actor) throw new Error('Actor cannot manage this Team thread')
      if (current.status === 'completed' || current.status === 'cancelled') throw new Error('Closed Team threads cannot be changed')
      if (current.version !== expectedVersion) throw new Error('Thread version conflict')
      const participants = patch.participantBotIds === undefined ? [...current.participantBotIds] : botIds(patch.participantBotIds)
      if (participants.some(id => !team.memberBotIds.includes(id))) throw new Error('Thread participant is not a Team member')
      const managerBotId = Object.hasOwn(patch, 'managerBotId')
        ? managerFor(patch.managerBotId, participants)
        : managerFor(current.managerBotId, participants)
      const status = patch.status ?? current.status
      if (!isThreadStatus(status)) throw new Error('Unsupported thread status')
      const taskId = Object.hasOwn(patch, 'taskId') ? optionalText(patch.taskId, 256) : current.taskId
      const artifacts = patch.artifacts === undefined
        ? [...current.artifacts]
        : patch.artifacts.map(item => artifact(item, at))
      if (artifacts.length > 50) throw new Error('Thread has too many artifacts')
      const { managerBotId: _oldManagerBotId, taskId: _oldTaskId, ...threadBase } = current
      const thread: AgentThread = {
        ...threadBase,
        participantBotIds: participants,
        ...(managerBotId === undefined ? {} : { managerBotId }),
        ...(taskId === undefined ? {} : { taskId }),
        artifacts,
        status,
        version: current.version + 1,
        updatedAt: at,
      }
      await this.commit({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), kind: 'thread.saved', at, actor, thread })
      return clone(thread)
    })
  }

  public async getThread(threadId: string): Promise<AgentThread | undefined> {
    await this.load()
    const thread = this.threads.get(threadId)
    return thread === undefined ? undefined : clone(thread)
  }

  public async listThreads(teamId?: string): Promise<AgentThread[]> {
    await this.load()
    return [...this.threads.values()]
      .filter(thread => teamId === undefined || thread.teamId === teamId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(event: TeamStoreEvent): Promise<void> {
    assertNoCredentialMaterial(event, 'Team state cannot contain API keys or credential-bearing URLs')
    await this.journal.append(event)
    this.apply(event)
  }

  private apply(event: TeamStoreEvent): void {
    if (event?.schemaVersion !== SCHEMA_VERSION || typeof event.eventId !== 'string' || this.eventIds.has(event.eventId)) return
    if (event.kind === 'team.saved' && isTeam(event.team) && validTeamShape(event.team)) {
      const current = this.teams.get(event.team.id)
      if (current === undefined) {
        if (event.team.version !== 1 || event.team.createdAt !== event.team.updatedAt || event.team.status === 'deleted') return
      } else if (!sameTeamIdentity(current, event.team)
        || current.status === 'deleted'
        || event.team.version !== current.version + 1
        || event.team.updatedAt < current.updatedAt) return
      this.teams.set(event.team.id, clone(event.team))
    } else if (event.kind === 'thread.saved' && isThread(event.thread)) {
      const team = this.teams.get(event.thread.teamId)
      if (team === undefined
        || event.thread.participantBotIds.length < 1
        || event.thread.participantBotIds.length > 6
        || new Set(event.thread.participantBotIds).size !== event.thread.participantBotIds.length
        || event.thread.participantBotIds.some(id => !team.memberBotIds.includes(id))
        || (event.thread.managerBotId !== undefined && !event.thread.participantBotIds.includes(event.thread.managerBotId))) return
      const current = this.threads.get(event.thread.id)
      if (current === undefined) {
        if (event.thread.version !== 1 || event.thread.createdAt !== event.thread.updatedAt) return
      } else if (!sameThreadIdentity(current, event.thread)
        || current.status === 'completed'
        || current.status === 'cancelled'
        || event.thread.version !== current.version + 1
        || event.thread.updatedAt < current.updatedAt) return
      this.threads.set(event.thread.id, clone(event.thread))
    } else return
    this.eventIds.add(event.eventId)
  }

  private requireTeam(teamId: string): TeamDefinition {
    const team = this.teams.get(teamId)
    if (team === undefined) throw new Error('Team does not exist')
    return team
  }

  private requireThread(threadId: string): AgentThread {
    const thread = this.threads.get(threadId)
    if (thread === undefined) throw new Error('Team thread does not exist')
    return thread
  }
}
