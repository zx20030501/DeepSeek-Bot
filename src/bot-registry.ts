import { createHash, randomUUID } from 'node:crypto'
import { assertNoCredentialMaterial } from './credential-scan.js'
import { JsonlJournal } from './jsonl.js'
import type {
  BotDefinition,
  BotDefinitionScope,
  BotDefinitionSource,
  BotDefinitionStatus,
  BotProfile,
  BotRegistryContext,
  BotRegistryEntry,
  BotRegistryRole,
  BotRevision,
  BotRevisionDraft,
  BotSessionScope,
  CreateBotDefinitionInput,
} from './types.js'

const SCHEMA_VERSION = 1 as const
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const PRIVILEGED_ACTORS = new Set(['local-dashboard', 'system:config', 'system:migration'])

type BotRegistryEventKind = 'bot.created' | 'bot.revised' | 'bot.status'

interface BotRegistryEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly eventId: string
  readonly kind: BotRegistryEventKind
  readonly at: number
  readonly actor: string
  readonly definition: BotDefinition
  readonly revision?: BotRevision
}

export interface BotRegistryStats {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly definitions: number
  readonly active: number
  readonly drafts: number
  readonly disabled: number
  readonly deleted: number
  readonly revisions: number
}

/** Stable fingerprint for the exact draft content presented for activation. */
export function botActivationFingerprint(entry: BotRegistryEntry): string {
  const { definition, revision } = entry
  return createHash('sha256').update(JSON.stringify({
    botId: definition.id,
    handle: definition.handle,
    scope: definition.scope,
    ownerId: definition.ownerId,
    workspaceId: definition.workspaceId ?? null,
    sessionId: definition.sessionId ?? null,
    definitionVersion: definition.version,
    currentRevision: definition.currentRevision,
    revision: {
      id: revision.id,
      revision: revision.revision,
      title: revision.title,
      description: revision.description ?? null,
      provider: revision.provider ?? null,
      model: revision.model ?? null,
      maxTokens: revision.maxTokens ?? null,
      runtimeAdapter: revision.runtimeAdapter ?? 'dsh',
      capabilities: [...revision.capabilities],
      skills: [...revision.skills],
      soul: revision.soul ?? null,
      fleetRole: revision.fleetRole,
      sessionScope: revision.sessionScope,
      allowedUserIds: [...revision.allowedUserIds],
      allowedChatIds: [...revision.allowedChatIds],
      approvalRequired: revision.approvalRequired,
    },
  })).digest('hex')
}

/**
 * Project an active registry revision onto the legacy runtime profile seam.
 * Phase 2 deliberately activates only user-scoped and shared Bots. Session and
 * workspace scopes need richer invocation context before they can be exposed
 * without widening access.
 */
export function runtimeProfileFor(entry: BotRegistryEntry): BotProfile | undefined {
  const { definition, revision } = entry
  if (definition.status !== 'active' || revision.fleetRole === 'manager') return undefined
  if (definition.scope === 'session' || definition.scope === 'workspace') return undefined
  const ownerPrincipal = definition.scope === 'user' && /^user:[^:]+:.+$/u.test(definition.ownerId)
    ? definition.ownerId
    : undefined
  if (definition.scope === 'user' && ownerPrincipal === undefined) return undefined
  return {
    name: definition.handle,
    title: revision.title,
    ...(revision.description === undefined ? {} : { description: revision.description }),
    ...(revision.provider === undefined ? {} : { provider: revision.provider }),
    ...(revision.model === undefined ? {} : { model: revision.model }),
    ...(revision.maxTokens === undefined ? {} : { maxTokens: revision.maxTokens }),
    ...(revision.runtimeAdapter === undefined ? {} : { runtimeAdapter: revision.runtimeAdapter }),
    capabilities: [...revision.capabilities],
    skills: [...revision.skills],
    ...(revision.soul === undefined ? {} : { soul: revision.soul }),
    fleetRole: revision.fleetRole,
    sessionScope: revision.sessionScope,
    allowedUserIds: ownerPrincipal === undefined ? [...revision.allowedUserIds] : [],
    allowedChatIds: ownerPrincipal === undefined ? [...revision.allowedChatIds] : [],
    allowedPrincipals: ownerPrincipal === undefined ? [] : [ownerPrincipal],
    approvalRequired: revision.approvalRequired,
    enabled: true,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function cleanRequired(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} is too long`)
  return normalized
}

function cleanOptional(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maximum) throw new Error('Bot field is too long')
  return normalized
}

function cleanIdentifier(value: string | undefined, label: string, maximum: number, allowRoute = false): string | undefined {
  const normalized = cleanOptional(value, maximum)
  if (normalized === undefined) return undefined
  const pattern = allowRoute
    ? /^[a-z0-9][a-z0-9._:/-]*$/iu
    : /^[a-z0-9][a-z0-9._-]*$/iu
  if (!pattern.test(normalized) || normalized.includes('://') || /[?&#=@]/u.test(normalized)) {
    throw new Error(`${label} must be a configured identifier, not a URL or credential-bearing value`)
  }
  return normalized
}

function uniqueStrings(values: readonly (string | number)[] | undefined, maximum = 32): string[] {
  const result = [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))]
  if (result.length > maximum) throw new Error(`Bot list exceeds ${maximum} entries`)
  if (result.some(value => value.length > 128)) throw new Error('Bot list entry is too long')
  return result
}

function isRole(value: unknown): value is BotRegistryRole {
  return value === 'worker' || value === 'verifier' || value === 'synthesizer' || value === 'generalist' || value === 'manager'
}

function isSessionScope(value: unknown): value is BotSessionScope {
  return value === 'requester' || value === 'chat' || value === 'shared' || value === 'task'
}

function isDefinitionScope(value: unknown): value is BotDefinitionScope {
  return value === 'session' || value === 'user' || value === 'workspace' || value === 'shared'
}

function isSource(value: unknown): value is BotDefinitionSource {
  return value === 'config' || value === 'chat' || value === 'dashboard' || value === 'import'
}

function isStatus(value: unknown): value is BotDefinitionStatus {
  return value === 'draft' || value === 'active' || value === 'disabled' || value === 'deleted'
}

function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase()
  if (!HANDLE_PATTERN.test(handle)) throw new Error('Bot handle must match [a-z0-9][a-z0-9_-]{0,63}')
  return handle
}

function normalizeScope(input: Pick<CreateBotDefinitionInput, 'scope' | 'ownerId' | 'workspaceId' | 'sessionId'>): {
  scope: BotDefinitionScope
  ownerId: string
  workspaceId?: string
  sessionId?: string
} {
  if (!isDefinitionScope(input.scope)) throw new Error('Unsupported Bot scope')
  const ownerId = cleanRequired(input.ownerId, 'Bot owner', 256)
  const workspaceId = cleanOptional(input.workspaceId, 256)
  const sessionId = cleanOptional(input.sessionId, 256)
  if (input.scope === 'workspace' && workspaceId === undefined) throw new Error('workspace scope requires workspaceId')
  if (input.scope === 'session' && sessionId === undefined) throw new Error('session scope requires sessionId')
  return {
    scope: input.scope,
    ownerId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function canManage(definition: BotDefinition, actor: string): boolean {
  return actor === definition.ownerId || actor.startsWith('system:') || PRIVILEGED_ACTORS.has(actor)
}

function canCreate(ownerId: string, actor: string): boolean {
  return actor === ownerId || actor.startsWith('system:') || PRIVILEGED_ACTORS.has(actor)
}

function visibleTo(definition: BotDefinition, context: BotRegistryContext): boolean {
  if (definition.scope === 'shared') return true
  if (definition.scope === 'workspace') return definition.workspaceId !== undefined && definition.workspaceId === context.workspaceId
  if (definition.scope === 'session') return definition.ownerId === context.actorId && definition.sessionId !== undefined && definition.sessionId === context.sessionId
  return definition.ownerId === context.actorId
}

function normalizeRevision(
  botId: string,
  revision: number,
  draft: BotRevisionDraft,
  actor: string,
  at: number,
): BotRevision {
  assertNoCredentialMaterial(draft, 'Bot definitions cannot contain API keys or credential material')
  const title = cleanRequired(draft.title, 'Bot title', 120)
  const description = cleanOptional(draft.description, 2_000)
  const provider = cleanIdentifier(draft.provider, 'Bot provider', 128)
  const model = cleanIdentifier(draft.model, 'Bot model', 256, true)
  const soul = cleanOptional(draft.soul, 12_000)
  const changeSummary = cleanOptional(draft.changeSummary, 500)
  const fleetRole = draft.fleetRole ?? 'generalist'
  const sessionScope = draft.sessionScope ?? 'requester'
  if (!isRole(fleetRole)) throw new Error('Unsupported Fleet role')
  if (!isSessionScope(sessionScope)) throw new Error('Unsupported Bot session scope')
  const maxTokens = draft.maxTokens
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2_000_000)) {
    throw new Error('maxTokens must be an integer between 1 and 2000000')
  }
  const runtimeAdapter = draft.runtimeAdapter ?? 'dsh'
  if (runtimeAdapter !== 'dsh' && runtimeAdapter !== 'hermes' && runtimeAdapter !== 'grok') {
    throw new Error('Unsupported Bot runtime adapter')
  }
  return {
    id: randomUUID(),
    botId,
    revision,
    title,
    ...(description === undefined ? {} : { description }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    runtimeAdapter,
    capabilities: uniqueStrings(draft.capabilities),
    skills: uniqueStrings(draft.skills),
    ...(soul === undefined ? {} : { soul }),
    fleetRole,
    sessionScope,
    allowedUserIds: uniqueStrings(draft.allowedUserIds, 256),
    allowedChatIds: uniqueStrings(draft.allowedChatIds, 256),
    approvalRequired: draft.approvalRequired === true,
    createdBy: cleanRequired(actor, 'Revision actor', 256),
    createdAt: at,
    ...(changeSummary === undefined ? {} : { changeSummary }),
  }
}

function revisedDraft(current: BotRevision, patch: Partial<BotRevisionDraft>): BotRevisionDraft {
  const optional = <K extends 'description' | 'provider' | 'model' | 'soul' | 'changeSummary'>(key: K): string | undefined => (
    Object.hasOwn(patch, key) ? patch[key] : current[key]
  )
  const description = optional('description')
  const provider = optional('provider')
  const model = optional('model')
  const soul = optional('soul')
  const changeSummary = optional('changeSummary')
  return {
    title: patch.title ?? current.title,
    ...(description === undefined ? {} : { description }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(Object.hasOwn(patch, 'maxTokens')
      ? patch.maxTokens === undefined ? {} : { maxTokens: patch.maxTokens }
      : current.maxTokens === undefined ? {} : { maxTokens: current.maxTokens }),
    runtimeAdapter: patch.runtimeAdapter ?? current.runtimeAdapter ?? 'dsh',
    capabilities: patch.capabilities ?? current.capabilities,
    skills: patch.skills ?? current.skills,
    ...(soul === undefined ? {} : { soul }),
    fleetRole: patch.fleetRole ?? current.fleetRole,
    sessionScope: patch.sessionScope ?? current.sessionScope,
    allowedUserIds: patch.allowedUserIds ?? current.allowedUserIds,
    allowedChatIds: patch.allowedChatIds ?? current.allowedChatIds,
    approvalRequired: patch.approvalRequired ?? current.approvalRequired,
    ...(changeSummary === undefined ? {} : { changeSummary }),
  }
}

function isDefinition(value: unknown): value is BotDefinition {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<BotDefinition>
  return typeof item.id === 'string'
    && typeof item.handle === 'string'
    && isDefinitionScope(item.scope)
    && typeof item.ownerId === 'string'
    && isSource(item.source)
    && isStatus(item.status)
    && Number.isInteger(item.version)
    && Number.isInteger(item.currentRevision)
    && (item.scope !== 'workspace' || typeof item.workspaceId === 'string')
    && (item.scope !== 'session' || typeof item.sessionId === 'string')
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number'
}

function isRevision(value: unknown): value is BotRevision {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<BotRevision>
  return typeof item.id === 'string'
    && typeof item.botId === 'string'
    && Number.isInteger(item.revision)
    && typeof item.title === 'string'
    && isRole(item.fleetRole)
    && isSessionScope(item.sessionScope)
    && Array.isArray(item.capabilities)
    && Array.isArray(item.skills)
    && Array.isArray(item.allowedUserIds)
    && Array.isArray(item.allowedChatIds)
    && typeof item.approvalRequired === 'boolean'
    && typeof item.createdBy === 'string'
    && typeof item.createdAt === 'number'
}

function sameDefinitionIdentity(left: BotDefinition, right: BotDefinition): boolean {
  return left.id === right.id
    && left.handle === right.handle
    && left.scope === right.scope
    && left.ownerId === right.ownerId
    && left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.source === right.source
    && left.createdAt === right.createdAt
}

function sameRevisionContent(left: BotRevision, right: BotRevision): boolean {
  const content = (revision: BotRevision): unknown => ({
    title: revision.title,
    description: revision.description ?? null,
    provider: revision.provider ?? null,
    model: revision.model ?? null,
    maxTokens: revision.maxTokens ?? null,
    runtimeAdapter: revision.runtimeAdapter ?? 'dsh',
    capabilities: revision.capabilities,
    skills: revision.skills,
    soul: revision.soul ?? null,
    fleetRole: revision.fleetRole,
    sessionScope: revision.sessionScope,
    allowedUserIds: revision.allowedUserIds,
    allowedChatIds: revision.allowedChatIds,
    approvalRequired: revision.approvalRequired,
  })
  return JSON.stringify(content(left)) === JSON.stringify(content(right))
}

/**
 * Versioned, append-only Bot registry. It stores identities and immutable
 * revisions only; credentials intentionally have no field in this schema.
 */
export class BotRegistry {
  private readonly journal: JsonlJournal<BotRegistryEvent>
  private readonly definitions = new Map<string, BotDefinition>()
  private readonly handles = new Map<string, string>()
  private readonly revisions = new Map<string, BotRevision[]>()
  private readonly eventIds = new Set<string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  public constructor(file: string) {
    this.journal = new JsonlJournal<BotRegistryEvent>(file)
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

  public stats(): BotRegistryStats {
    const definitions = [...this.definitions.values()]
    return {
      schemaVersion: SCHEMA_VERSION,
      definitions: definitions.length,
      active: definitions.filter(item => item.status === 'active').length,
      drafts: definitions.filter(item => item.status === 'draft').length,
      disabled: definitions.filter(item => item.status === 'disabled').length,
      deleted: definitions.filter(item => item.status === 'deleted').length,
      revisions: [...this.revisions.values()].reduce((total, items) => total + items.length, 0),
    }
  }

  public async create(input: CreateBotDefinitionInput, actor: string, at = Date.now()): Promise<BotRegistryEntry> {
    await this.load()
    return this.mutate(() => this.createLocked(input, actor, at))
  }

  public async revise(
    botId: string,
    patch: Partial<BotRevisionDraft>,
    actor: string,
    expectedVersion: number,
    at = Date.now(),
  ): Promise<BotRegistryEntry> {
    await this.load()
    return this.mutate(() => this.reviseLocked(botId, patch, actor, expectedVersion, at))
  }

  public async setStatus(
    botId: string,
    status: Exclude<BotDefinitionStatus, 'draft'>,
    actor: string,
    expectedVersion: number,
    at = Date.now(),
  ): Promise<BotRegistryEntry> {
    await this.load()
    return this.mutate(() => this.setStatusLocked(botId, status, actor, expectedVersion, at))
  }

  public async get(botId: string): Promise<BotRegistryEntry | undefined> {
    await this.load()
    const definition = this.definitions.get(botId)
    return definition === undefined ? undefined : this.entryFor(definition.id)
  }

  public async getByHandle(handle: string): Promise<BotRegistryEntry | undefined> {
    await this.load()
    const id = this.handles.get(handle.trim().toLowerCase())
    return id === undefined ? undefined : this.entryFor(id)
  }

  public async list(context?: BotRegistryContext, includeDeleted = false): Promise<BotRegistryEntry[]> {
    await this.load()
    return [...this.definitions.values()]
      .filter(definition => includeDeleted || definition.status !== 'deleted')
      .filter(definition => context === undefined || visibleTo(definition, context))
      .sort((left, right) => left.createdAt - right.createdAt || left.handle.localeCompare(right.handle))
      .map(definition => this.entryFor(definition.id))
  }

  public async history(botId: string): Promise<BotRevision[]> {
    await this.load()
    this.requireDefinition(botId)
    return clone(this.revisions.get(botId) ?? [])
  }

  /** Idempotently seeds legacy static profiles without changing their current runtime path. */
  public async seedStaticProfiles(profiles: Iterable<BotProfile>, at = Date.now()): Promise<BotRegistryEntry[]> {
    await this.load()
    return this.mutate(async () => {
      const result: BotRegistryEntry[] = []
      for (const profile of profiles) {
        const handle = normalizeHandle(profile.name)
        const draft: BotRevisionDraft = {
          title: profile.title ?? profile.name,
          ...(profile.description === undefined ? {} : { description: profile.description }),
          ...(profile.provider === undefined ? {} : { provider: profile.provider }),
          ...(profile.model === undefined ? {} : { model: profile.model }),
          ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
          ...(profile.runtimeAdapter === undefined ? {} : { runtimeAdapter: profile.runtimeAdapter }),
          capabilities: profile.capabilities ?? [],
          skills: profile.skills ?? [],
          ...(profile.soul === undefined ? {} : { soul: profile.soul }),
          fleetRole: profile.fleetRole ?? 'generalist',
          sessionScope: profile.sessionScope ?? 'requester',
          allowedUserIds: profile.allowedUserIds ?? [],
          allowedChatIds: profile.allowedChatIds ?? [],
          approvalRequired: profile.approvalRequired === true,
          changeSummary: 'Imported from static plugin configuration',
        }
        const existingId = this.handles.get(handle)
        if (existingId === undefined) {
          result.push(await this.createLocked({
            handle,
            scope: 'shared',
            ownerId: 'system:config',
            source: 'config',
            status: profile.enabled === false ? 'disabled' : 'active',
            revision: draft,
          }, 'system:config', at))
          continue
        }
        const existing = this.entryFor(existingId)
        if (existing.definition.source !== 'config' || existing.definition.status === 'deleted') {
          throw new Error(`Bot handle @${handle} is reserved by a dynamic definition or tombstone`)
        }
        const candidate = normalizeRevision(existing.definition.id, existing.definition.currentRevision + 1, draft, 'system:config', at)
        let current = existing
        if (!sameRevisionContent(current.revision, candidate)) {
          current = await this.reviseLocked(current.definition.id, draft, 'system:config', current.definition.version, at)
        }
        const desiredStatus = profile.enabled === false ? 'disabled' : 'active'
        if (current.definition.status !== desiredStatus) {
          current = await this.setStatusLocked(current.definition.id, desiredStatus, 'system:config', current.definition.version, at)
        }
        result.push(current)
      }
      return result
    })
  }

  private async createLocked(input: CreateBotDefinitionInput, actor: string, at: number): Promise<BotRegistryEntry> {
    const handle = normalizeHandle(input.handle)
    if (this.handles.has(handle)) throw new Error('Bot handle already exists')
    const scope = normalizeScope(input)
    if (!canCreate(scope.ownerId, actor)) throw new Error('Actor cannot create a Bot for this owner')
    const source = input.source ?? 'chat'
    if (!isSource(source)) throw new Error('Unsupported Bot source')
    const status = input.status ?? 'draft'
    if (status !== 'draft' && status !== 'active' && status !== 'disabled') throw new Error('New Bots must start as draft, active, or disabled')
    const id = randomUUID()
    const revision = normalizeRevision(id, 1, input.revision, actor, at)
    const definition: BotDefinition = {
      id,
      handle,
      ...scope,
      source,
      status,
      version: 1,
      currentRevision: 1,
      createdAt: at,
      updatedAt: at,
    }
    await this.commit({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      kind: 'bot.created',
      at,
      actor: cleanRequired(actor, 'Creation actor', 256),
      definition,
      revision,
    })
    return this.entryFor(id)
  }

  private async reviseLocked(
    botId: string,
    patch: Partial<BotRevisionDraft>,
    actor: string,
    expectedVersion: number,
    at: number,
  ): Promise<BotRegistryEntry> {
    const definition = this.requireDefinition(botId)
    if (!canManage(definition, actor)) throw new Error('Actor cannot manage this Bot')
    if (definition.status === 'deleted') throw new Error('Deleted Bot identities cannot be changed')
    if (definition.version !== expectedVersion) throw new Error('Bot version conflict')
    const current = this.currentRevision(definition.id)
    const revision = normalizeRevision(
      definition.id,
      definition.currentRevision + 1,
      revisedDraft(current, patch),
      actor,
      at,
    )
    const next: BotDefinition = {
      ...definition,
      version: definition.version + 1,
      currentRevision: revision.revision,
      updatedAt: at,
    }
    await this.commit({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      kind: 'bot.revised',
      at,
      actor: cleanRequired(actor, 'Revision actor', 256),
      definition: next,
      revision,
    })
    return this.entryFor(botId)
  }

  private async setStatusLocked(
    botId: string,
    status: Exclude<BotDefinitionStatus, 'draft'>,
    actor: string,
    expectedVersion: number,
    at: number,
  ): Promise<BotRegistryEntry> {
    const definition = this.requireDefinition(botId)
    if (!canManage(definition, actor)) throw new Error('Actor cannot manage this Bot')
    if (definition.status === 'deleted') throw new Error('Deleted Bot identities cannot be changed')
    if (definition.version !== expectedVersion) throw new Error('Bot version conflict')
    if (status !== 'active' && status !== 'disabled' && status !== 'deleted') throw new Error('Unsupported Bot status')
    if (definition.status === status) return this.entryFor(definition.id)
    const next: BotDefinition = { ...definition, status, version: definition.version + 1, updatedAt: at }
    await this.commit({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      kind: 'bot.status',
      at,
      actor: cleanRequired(actor, 'Lifecycle actor', 256),
      definition: next,
    })
    return this.entryFor(next.id)
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(event: BotRegistryEvent): Promise<void> {
    await this.journal.append(event)
    this.apply(event)
  }

  private apply(event: BotRegistryEvent): void {
    if (event?.schemaVersion !== SCHEMA_VERSION || typeof event.eventId !== 'string' || this.eventIds.has(event.eventId)) return
    if (!isDefinition(event.definition) || !HANDLE_PATTERN.test(event.definition.handle)) return
    if (event.kind !== 'bot.created' && event.kind !== 'bot.revised' && event.kind !== 'bot.status') return
    const existing = this.definitions.get(event.definition.id)
    if (event.kind === 'bot.created') {
      if (existing !== undefined || this.handles.has(event.definition.handle)) return
      if (!isRevision(event.revision)
        || event.definition.version !== 1
        || event.definition.currentRevision !== 1
        || event.definition.status === 'deleted'
        || event.definition.createdAt !== event.definition.updatedAt
        || event.revision.botId !== event.definition.id
        || event.revision.revision !== 1) return
    } else {
      if (existing === undefined || !sameDefinitionIdentity(existing, event.definition)) return
      if (event.definition.version !== existing.version + 1) return
      if (event.definition.updatedAt < existing.updatedAt) return
      if (event.kind === 'bot.revised') {
        if (!isRevision(event.revision)
          || event.definition.status !== existing.status
          || event.definition.currentRevision !== existing.currentRevision + 1
          || event.revision.botId !== event.definition.id
          || event.revision.revision !== event.definition.currentRevision) return
      } else if (event.revision !== undefined
        || event.definition.currentRevision !== existing.currentRevision
        || event.definition.status === existing.status) return
    }
    this.eventIds.add(event.eventId)
    this.definitions.set(event.definition.id, clone(event.definition))
    this.handles.set(event.definition.handle, event.definition.id)
    if (event.revision !== undefined) {
      const history = this.revisions.get(event.definition.id) ?? []
      if (!history.some(item => item.id === event.revision?.id)) {
        history.push(clone(event.revision))
        history.sort((left, right) => left.revision - right.revision)
        this.revisions.set(event.definition.id, history)
      }
    }
  }

  private requireDefinition(botId: string): BotDefinition {
    const definition = this.definitions.get(botId)
    if (definition === undefined) throw new Error('Bot does not exist')
    return definition
  }

  private currentRevision(botId: string): BotRevision {
    const definition = this.requireDefinition(botId)
    const revision = (this.revisions.get(botId) ?? []).find(item => item.revision === definition.currentRevision)
    if (revision === undefined) throw new Error('Bot current revision is missing')
    return revision
  }

  private entryFor(botId: string): BotRegistryEntry {
    return clone({ definition: this.requireDefinition(botId), revision: this.currentRevision(botId) })
  }
}
