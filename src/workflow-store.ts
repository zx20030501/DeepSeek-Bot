import { createHash, randomUUID } from 'node:crypto'
import { assertNoCredentialMaterial } from './credential-scan.js'
import { JsonlJournal } from './jsonl.js'
import {
  FLEET_V2_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowManifest,
  type WorkflowScope,
} from './fleet-v2-types.js'
import {
  assertValidWorkflow,
  assertValidWorkflowDraft,
  validateWorkflow,
  validateWorkflowDraft,
  type WorkflowDraftValidationResult,
} from './workflow-schema.js'

const STORE_SCHEMA_VERSION = 1 as const

export interface WorkflowVisibilityContext {
  readonly actorId: string
  readonly workspaceId?: string
}

export type WorkflowUpdateInput = Partial<Omit<WorkflowDraft, 'ownerId' | 'scope'>>

export type WorkflowStoreEvent = {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION
  readonly eventId: string
  readonly kind: 'workflow.created' | 'workflow.revised' | 'workflow.deleted'
  readonly at: number
  readonly actor: string
  readonly operationKey: string
  readonly operationFingerprint: string
  readonly workflow: WorkflowDefinition
}

interface OperationRecord {
  readonly kind: WorkflowStoreEvent['kind']
  readonly workflowId: string
  readonly revision: number
  readonly fingerprint: string
}

export class WorkflowStoreError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'WorkflowStoreError'
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function actorCanManage(ownerId: string, actor: string): boolean {
  return actor === ownerId || actor === 'local-dashboard' || actor.startsWith('system:')
}

function visibleTo(workflow: WorkflowDefinition, context: WorkflowVisibilityContext): boolean {
  if (workflow.scope === 'shared') return true
  if (workflow.scope === 'workspace') return workflow.ownerId === context.actorId || (context.workspaceId !== undefined && workflow.workspaceId === context.workspaceId)
  return workflow.ownerId === context.actorId
}

function defaultOperationKey(kind: string, actor: string, input: unknown): string {
  return `workflow:${kind}:${actor}:${sha256(input)}`
}

function isStoreEvent(value: unknown): value is WorkflowStoreEvent {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<WorkflowStoreEvent>
  if (item.schemaVersion !== STORE_SCHEMA_VERSION
    || typeof item.eventId !== 'string'
    || (item.kind !== 'workflow.created' && item.kind !== 'workflow.revised' && item.kind !== 'workflow.deleted')
    || typeof item.at !== 'number'
    || typeof item.actor !== 'string'
    || typeof item.operationKey !== 'string'
    || typeof item.operationFingerprint !== 'string') return false
  return validateWorkflow(item.workflow).ok
}

/**
 * Append-only Workflow definition store. It stores definitions and revisions,
 * never execution state, credentials, leases, or messages.
 */
export class WorkflowStore {
  private readonly journal: JsonlJournal<WorkflowStoreEvent>
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private readonly operations = new Map<string, OperationRecord>()
  private readonly eventIds = new Set<string>()
  private loaded = false
  private loading: Promise<void> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  public constructor(private readonly file: string) {
    this.journal = new JsonlJournal<WorkflowStoreEvent>(file)
  }

  public async load(): Promise<void> {
    if (this.loaded) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      for (const raw of await this.journal.read()) {
        if (!isStoreEvent(raw)) throw new WorkflowStoreError('WORKFLOW_STORE_CORRUPT', 'Workflow store contains an invalid event')
        this.apply(raw)
      }
      this.loaded = true
    })()
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  public validate(input: unknown): WorkflowDraftValidationResult {
    return validateWorkflowDraft(input)
  }

  public async create(
    input: WorkflowDraft,
    actor = input.ownerId,
    idempotencyKey?: string,
    at = Date.now(),
  ): Promise<WorkflowDefinition> {
    return this.mutate(async () => {
      await this.load()
      const draft = assertValidWorkflowDraft(input)
      if (!actorCanManage(draft.ownerId, actor)) throw new WorkflowStoreError('WORKFLOW_OWNER_DENIED', 'Actor cannot create this Workflow')
      const operationFingerprint = sha256({ kind: 'create', draft })
      const key = idempotencyKey ?? defaultOperationKey('create', actor, draft)
      const existing = this.existingOperation(key, operationFingerprint)
      if (existing !== undefined) return clone(existing)
      const workflow: WorkflowDefinition = {
        schemaVersion: FLEET_V2_SCHEMA_VERSION,
        id: `wf_${randomUUID()}`,
        revision: 1,
        status: 'active',
        createdAt: at,
        updatedAt: at,
        ...draft,
      }
      await this.append({
        schemaVersion: STORE_SCHEMA_VERSION,
        eventId: randomUUID(),
        kind: 'workflow.created',
        at,
        actor,
        operationKey: key,
        operationFingerprint,
        workflow,
      })
      return clone(workflow)
    })
  }

  public async list(context?: WorkflowVisibilityContext, includeDeleted = false): Promise<WorkflowDefinition[]> {
    await this.load()
    return [...this.workflows.values()]
      .filter(workflow => includeDeleted || workflow.status !== 'deleted')
      .filter(workflow => context === undefined || visibleTo(workflow, context))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      .map(workflow => clone(workflow))
  }

  public async get(
    workflowId: string,
    context?: WorkflowVisibilityContext,
    includeDeleted = false,
  ): Promise<WorkflowDefinition | undefined> {
    await this.load()
    const workflow = this.workflows.get(workflowId)
    if (workflow === undefined || (!includeDeleted && workflow.status === 'deleted')) return undefined
    if (context !== undefined && !visibleTo(workflow, context)) return undefined
    return clone(workflow)
  }

  public async update(
    workflowId: string,
    patch: WorkflowUpdateInput,
    actor: string,
    expectedRevision: number,
    idempotencyKey?: string,
    at = Date.now(),
  ): Promise<WorkflowDefinition> {
    return this.mutate(async () => {
      await this.load()
      assertNoCredentialMaterial(patch, 'Workflow update cannot contain credential material')
      const operationFingerprint = sha256({ kind: 'update', workflowId, expectedRevision, patch })
      const key = idempotencyKey ?? defaultOperationKey('update', actor, { workflowId, expectedRevision, patch })
      const existing = this.existingOperation(key, operationFingerprint)
      if (existing !== undefined) return clone(existing)
      const current = this.requireCurrent(workflowId)
      if (!actorCanManage(current.ownerId, actor)) throw new WorkflowStoreError('WORKFLOW_OWNER_DENIED', 'Actor cannot update this Workflow')
      if (current.status === 'deleted') throw new WorkflowStoreError('WORKFLOW_DELETED', 'Deleted Workflows cannot be updated')
      if (current.revision !== expectedRevision) throw new WorkflowStoreError('WORKFLOW_VERSION_CONFLICT', 'Workflow revision conflict')
      const nextDraft = assertValidWorkflowDraft({
        ...current,
        ...patch,
        ownerId: current.ownerId,
        scope: current.scope,
      })
      const workflow: WorkflowDefinition = {
        ...nextDraft,
        schemaVersion: FLEET_V2_SCHEMA_VERSION,
        id: current.id,
        revision: current.revision + 1,
        status: 'active',
        createdAt: current.createdAt,
        updatedAt: at,
      }
      await this.append({
        schemaVersion: STORE_SCHEMA_VERSION,
        eventId: randomUUID(),
        kind: 'workflow.revised',
        at,
        actor,
        operationKey: key,
        operationFingerprint,
        workflow,
      })
      return clone(workflow)
    })
  }

  public async softDelete(
    workflowId: string,
    actor: string,
    expectedRevision: number,
    idempotencyKey?: string,
    at = Date.now(),
  ): Promise<WorkflowDefinition> {
    return this.mutate(async () => {
      await this.load()
      const operationFingerprint = sha256({ kind: 'delete', workflowId, expectedRevision })
      const key = idempotencyKey ?? defaultOperationKey('delete', actor, { workflowId, expectedRevision })
      const existing = this.existingOperation(key, operationFingerprint)
      if (existing !== undefined) return clone(existing)
      const current = this.requireCurrent(workflowId)
      if (!actorCanManage(current.ownerId, actor)) throw new WorkflowStoreError('WORKFLOW_OWNER_DENIED', 'Actor cannot delete this Workflow')
      if (current.status === 'deleted') return clone(current)
      if (current.revision !== expectedRevision) throw new WorkflowStoreError('WORKFLOW_VERSION_CONFLICT', 'Workflow revision conflict')
      const workflow: WorkflowDefinition = { ...current, revision: current.revision + 1, status: 'deleted', updatedAt: at }
      await this.append({
        schemaVersion: STORE_SCHEMA_VERSION,
        eventId: randomUUID(),
        kind: 'workflow.deleted',
        at,
        actor,
        operationKey: key,
        operationFingerprint,
        workflow,
      })
      return clone(workflow)
    })
  }

  public async exportManifest(workflowId: string, context?: WorkflowVisibilityContext, at = Date.now()): Promise<WorkflowManifest> {
    const workflow = await this.get(workflowId, context)
    if (workflow === undefined) throw new WorkflowStoreError('WORKFLOW_NOT_FOUND', 'Workflow does not exist or is not visible')
    const manifest: WorkflowManifest = {
      manifestVersion: FLEET_V2_SCHEMA_VERSION,
      exportedAt: at,
      workflow,
      sha256: sha256(workflow),
    }
    assertNoCredentialMaterial(manifest, 'Workflow manifest cannot contain credential material')
    return clone(manifest)
  }

  public async importManifest(
    input: WorkflowManifest,
    actor: string,
    idempotencyKey?: string,
    at = Date.now(),
  ): Promise<WorkflowDefinition> {
    return this.mutate(async () => {
      await this.load()
      if (input === null || typeof input !== 'object') throw new WorkflowStoreError('WORKFLOW_MANIFEST_INVALID', 'Workflow manifest must be an object')
      assertNoCredentialMaterial(input, 'Workflow manifest cannot contain credential material')
      if (input.manifestVersion !== FLEET_V2_SCHEMA_VERSION) throw new WorkflowStoreError('WORKFLOW_MANIFEST_INVALID', 'Unsupported Workflow manifest version')
      const source = assertValidWorkflow(input.workflow)
      if (source.status === 'deleted') throw new WorkflowStoreError('WORKFLOW_MANIFEST_INVALID', 'Deleted Workflows cannot be imported')
      if (input.sha256 !== sha256(source)) throw new WorkflowStoreError('WORKFLOW_MANIFEST_INVALID', 'Workflow manifest checksum mismatch')
      const draft: WorkflowDraft = {
        name: source.name,
        ...(source.description === undefined ? {} : { description: source.description }),
        ownerId: actor,
        scope: 'user',
        ...(source.tags === undefined ? {} : { tags: source.tags }),
        entryNodeId: source.entryNodeId,
        nodes: source.nodes,
        edges: source.edges,
        inputs: source.inputs,
        outputs: source.outputs,
        policy: source.policy,
      }
      const operationFingerprint = sha256({ kind: 'import', source: input.sha256, actor, draft })
      const key = idempotencyKey ?? defaultOperationKey('import', actor, { source: input.sha256, draft })
      const existing = this.existingOperation(key, operationFingerprint)
      if (existing !== undefined) return clone(existing)
      const workflow: WorkflowDefinition = {
        schemaVersion: FLEET_V2_SCHEMA_VERSION,
        id: `wf_${randomUUID()}`,
        revision: 1,
        status: 'active',
        createdAt: at,
        updatedAt: at,
        ...assertValidWorkflowDraft(draft),
      }
      await this.append({
        schemaVersion: STORE_SCHEMA_VERSION,
        eventId: randomUUID(),
        kind: 'workflow.created',
        at,
        actor,
        operationKey: key,
        operationFingerprint,
        workflow,
      })
      return clone(workflow)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T
    const current = this.mutationTail
      .catch(() => undefined)
      .then(async () => { result = await operation() })
    this.mutationTail = current.then(() => undefined, () => undefined)
    await current
    return result
  }

  private async append(event: WorkflowStoreEvent): Promise<void> {
    if (!validateWorkflow(event.workflow).ok) throw new WorkflowStoreError('WORKFLOW_INVALID_EVENT', 'Refusing to persist an invalid Workflow event')
    assertNoCredentialMaterial(event, 'Workflow store event cannot contain credential material')
    await this.journal.append(event)
    this.apply(event)
  }

  private apply(event: WorkflowStoreEvent): void {
    if (this.eventIds.has(event.eventId)) return
    const current = this.workflows.get(event.workflow.id)
    if (current !== undefined && current.revision >= event.workflow.revision) {
      this.eventIds.add(event.eventId)
      this.operations.set(event.operationKey, {
        kind: event.kind,
        workflowId: event.workflow.id,
        revision: event.workflow.revision,
        fingerprint: event.operationFingerprint,
      })
      return
    }
    this.workflows.set(event.workflow.id, clone(event.workflow))
    this.eventIds.add(event.eventId)
    this.operations.set(event.operationKey, {
      kind: event.kind,
      workflowId: event.workflow.id,
      revision: event.workflow.revision,
      fingerprint: event.operationFingerprint,
    })
  }

  private existingOperation(key: string, fingerprint: string): WorkflowDefinition | undefined {
    const existing = this.operations.get(key)
    if (existing === undefined) return undefined
    if (existing.fingerprint !== fingerprint) throw new WorkflowStoreError('WORKFLOW_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different operation')
    return this.workflows.get(existing.workflowId)
  }

  private requireCurrent(workflowId: string): WorkflowDefinition {
    const workflow = this.workflows.get(workflowId)
    if (workflow === undefined) throw new WorkflowStoreError('WORKFLOW_NOT_FOUND', 'Workflow does not exist')
    return workflow
  }
}
