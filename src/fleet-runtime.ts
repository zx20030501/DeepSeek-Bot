import { createHash } from 'node:crypto'
import { assertValidWorkflow } from './workflow-schema.js'
import type {
  BotAddress,
  BotDescriptor,
  BotMessageEnvelope,
  BotMessageKind,
  BotTarget,
} from './types.js'
import type {
  DelegationIntent,
  ManagerBotDescriptor,
  ManagerPlan,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeKind,
} from './fleet-v2-types.js'

export interface ManagerGatewayRequest {
  readonly requester: string
  readonly replyTarget: BotTarget
  readonly instruction: string
  readonly acceptanceCriteria?: readonly string[]
  readonly requiredCapabilities?: readonly string[]
  readonly risk?: 'low' | 'medium' | 'high'
  readonly requiresExternalEffect?: boolean
  readonly budget?: Partial<import('./fleet-v2-types.js').ManagerBudget>
  readonly maxAssignments?: number
  readonly managerBotId?: string
  readonly traceId?: string
  readonly approved?: boolean
}

export interface ManagerRuntimeResult {
  readonly taskId: string
  readonly traceId: string
  readonly plan: ManagerPlan
  readonly dispatched: readonly BotMessageEnvelope[]
  readonly approvalCode?: string
}

export class FleetRuntimeCompileError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'FleetRuntimeCompileError'
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 24)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizeId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FleetRuntimeCompileError('RUNTIME_INVALID_ID', label + ' is required')
  }
  return value.trim().toLowerCase()
}

function roleFor(bot: BotDescriptor): Exclude<ManagerBotDescriptor['role'], undefined> {
  return bot.fleetRole
}

function statusFor(bot: BotDescriptor, activeRuns: ReadonlyMap<string, string>): Exclude<ManagerBotDescriptor['status'], undefined> {
  if (!bot.enabled) return 'unavailable'
  return activeRuns.has(bot.id) ? 'busy' : 'available'
}

/**
 * Converts the canonical Gateway roster into the product-layer Manager input.
 * The ACL callback is deliberately required: product-layer authorization is
 * only a snapshot and never a substitute for a runtime authorization check.
 */
export function managerDescriptorsFromRoster(
  bots: readonly BotDescriptor[],
  replyTarget: BotTarget,
  canInvoke: (botId: string, target: BotTarget) => boolean,
  activeRuns: ReadonlyMap<string, string> = new Map(),
): readonly ManagerBotDescriptor[] {
  return bots.map(bot => ({
    id: bot.id,
    title: bot.title,
    capabilities: [...bot.capabilities],
    skills: [...bot.skills],
    role: roleFor(bot),
    enabled: bot.enabled,
    authorized: canInvoke(bot.id, replyTarget),
    status: statusFor(bot, activeRuns),
    inFlight: activeRuns.has(bot.id) ? 1 : 0,
  }))
}

export interface ManagerDispatchSpec {
  readonly intentId: string
  readonly idempotencyKey: string
  readonly kind: Extract<BotMessageKind, 'request' | 'reply' | 'report'>
  readonly from: BotAddress
  readonly to: BotAddress
  readonly instruction: string
  readonly acceptanceCriteria: readonly string[]
  readonly payload: Record<string, unknown>
  readonly hop: number
  readonly maxHops: number
}

export interface CompileManagerDispatchOptions {
  readonly approved?: boolean
  readonly maxDispatches?: number
}

/**
 * Turns a pure Manager plan into bounded dispatch descriptions. It still does
 * not create a Task, Run, Mailbox item or approval; those remain Gateway-owned.
 */
export function compileManagerDispatches(
  plan: ManagerPlan,
  options: CompileManagerDispatchOptions = {},
): readonly ManagerDispatchSpec[] {
  if (plan.schemaVersion !== 1) throw new FleetRuntimeCompileError('RUNTIME_UNSUPPORTED_PLAN', 'Unsupported Manager plan version')
  if (plan.policyDecision === 'deny' || plan.policyDecision === 'replan-required') {
    throw new FleetRuntimeCompileError('RUNTIME_PLAN_DENIED', 'Manager plan is not dispatchable: ' + plan.policyDecision)
  }
  if (plan.approval.required && options.approved !== true) {
    throw new FleetRuntimeCompileError('RUNTIME_APPROVAL_REQUIRED', 'Manager plan requires an approved delegation')
  }
  const limit = Math.min(
    plan.delegations.length,
    options.maxDispatches ?? plan.budget.maxParallelRuns,
    plan.budget.maxBots,
    plan.budget.maxFanOut,
  )
  if (!Number.isInteger(limit) || limit < 0) throw new FleetRuntimeCompileError('RUNTIME_BUDGET_INVALID', 'Manager dispatch limit is invalid')
  return plan.delegations.slice(0, limit).map((intent: DelegationIntent) => {
    const fromId = normalizeId(intent.fromManager, 'Manager identity')
    const toId = normalizeId(intent.toBot, 'delegation target')
    if (fromId === toId) throw new FleetRuntimeCompileError('RUNTIME_SELF_DELEGATION', 'Manager cannot delegate to itself')
    const hop = Math.max(0, Math.floor(intent.hop))
    const maxHops = Math.max(hop, Math.min(plan.budget.maxHops, plan.budget.maxDepth))
    return {
      intentId: intent.intentId,
      idempotencyKey: 'manager:' + plan.planId + ':' + intent.intentId,
      kind: 'request',
      from: { id: fromId, type: 'bot' },
      to: { id: toId, type: 'bot' },
      instruction: intent.instruction.slice(0, 20_000),
      acceptanceCriteria: [...intent.acceptanceCriteria].slice(0, 20),
      payload: {
        managerPlanId: plan.planId,
        managerPlanRevision: plan.planRevision,
        intentId: intent.intentId,
        traceId: plan.traceId,
        requester: intent.fromManager,
        visitedBots: [...intent.visitedBotIds].slice(0, 32),
        delegationReason: [...intent.reason].slice(0, 20),
        budget: { ...intent.budget },
      },
      hop,
      maxHops,
    }
  })
}

function dependencyMap(definition: WorkflowDefinition): Map<string, Set<string>> {
  const dependencies = new Map(definition.nodes.map(node => [node.id, new Set(node.dependsOn ?? [])]))
  for (const edge of definition.edges) dependencies.get(edge.to)?.add(edge.from)
  return dependencies
}

function topologicalOrder(definition: WorkflowDefinition, dependencies: Map<string, Set<string>>): string[] {
  const remaining = new Map([...dependencies.entries()].map(([id, values]) => [id, new Set(values)]))
  const order: string[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, values]) => values.size === 0)
      .map(([id]) => id)
      .sort()
    if (ready.length === 0) throw new FleetRuntimeCompileError('RUNTIME_WORKFLOW_CYCLE', 'Workflow dependencies contain a cycle')
    for (const id of ready) {
      order.push(id)
      remaining.delete(id)
      for (const values of remaining.values()) values.delete(id)
    }
  }
  return order
}

function entryTaskNodeIds(definition: WorkflowDefinition): string[] {
  const byId = new Map(definition.nodes.map(node => [node.id, node]))
  const seen = new Set<string>()
  const result: string[] = []
  const visit = (nodeId: string): void => {
    if (seen.has(nodeId)) return
    seen.add(nodeId)
    const node = byId.get(nodeId)
    if (!node) return
    if (node.kind === 'task') {
      result.push(node.id)
      return
    }
    if (node.kind === 'condition' || node.kind === 'approval') return
    for (const child of node.children ?? []) visit(child)
  }
  visit(definition.entryNodeId)
  return result
}

export interface WorkflowNodeDispatchSpec {
  readonly nodeId: string
  readonly label: string
  readonly kind: WorkflowNodeKind
  readonly capability?: string
  readonly dependsOn: readonly string[]
  readonly instruction: string
  readonly acceptanceCriteria: readonly string[]
  readonly outputNames: readonly string[]
  readonly maxConcurrency?: number
}

export interface WorkflowLaunchPlan {
  readonly definition: WorkflowDefinition
  readonly nodeOrder: readonly string[]
  readonly entryTaskIds: readonly string[]
  readonly nodes: readonly WorkflowNodeDispatchSpec[]
  readonly budget: {
    readonly maxParallel: number
    readonly maxFanOut: number
    readonly maxMessages: number
    readonly maxTokens: number
    readonly maxCostUnits: number
  }
}

/**
 * Validates a Workflow definition and compiles its declarative graph into
 * bounded Task/Run launch descriptions. It does not dispatch or evaluate
 * conditions, approvals, map/reduce or external effects.
 */
export function compileWorkflowLaunch(input: unknown): WorkflowLaunchPlan {
  const definition = assertValidWorkflow(input)
  const dependencies = dependencyMap(definition)
  const nodeOrder = topologicalOrder(definition, dependencies)
  const entryTaskIds = entryTaskNodeIds(definition)
  const nodes = nodeOrder.map(nodeId => {
    const node = definition.nodes.find(candidate => candidate.id === nodeId) as WorkflowNode
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      ...(node.capability === undefined ? {} : { capability: node.capability }),
      dependsOn: [...(dependencies.get(node.id) ?? [])].sort(),
      instruction: node.label.slice(0, 20_000),
      acceptanceCriteria: [...(node.outputs ?? [])].slice(0, 20),
      outputNames: [...(node.outputs ?? [])].slice(0, 20),
      ...(node.maxConcurrency === undefined ? {} : { maxConcurrency: node.maxConcurrency }),
    }
  })
  return {
    definition: clone(definition),
    nodeOrder,
    entryTaskIds,
    nodes,
    budget: {
      maxParallel: definition.policy.budget.maxParallel,
      maxFanOut: definition.policy.budget.maxFanOut,
      maxMessages: definition.policy.budget.maxMessages,
      maxTokens: definition.policy.budget.maxTokens,
      maxCostUnits: definition.policy.budget.maxCostUnits,
    },
  }
}

export function workflowNode(plan: WorkflowLaunchPlan, nodeId: string): WorkflowNodeDispatchSpec | undefined {
  return plan.nodes.find(node => node.nodeId === nodeId)
}

export function workflowDispatchKey(workflowId: string, revision: number, nodeId: string): string {
  return 'workflow:' + normalizeId(workflowId, 'workflowId') + ':revision:' + revision + ':node:' + normalizeId(nodeId, 'nodeId') + ':' + stableHash({ workflowId, revision, nodeId })
}
