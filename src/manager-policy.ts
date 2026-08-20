import { createHash } from 'node:crypto'
import { assertNoCredentialMaterial } from './credential-scan.js'
import type {
  ApprovalRequirement,
  DelegationBudgetSlice,
  DelegationIntent,
  ManagerBotDescriptor,
  ManagerBudget,
  ManagerPlan,
  ManagerReplanInput,
  ManagerReplanObservation,
  ManagerTaskInput,
  ReplanSuggestion,
} from './fleet-v2-types.js'

export const DEFAULT_MANAGER_BUDGET: ManagerBudget = {
  maxBots: 6,
  maxParallelRuns: 6,
  maxDepth: 4,
  maxMessages: 24,
  maxTokens: 120_000,
  maxCostUnits: 6_000,
  maxFanOut: 6,
  maxHops: 2,
}

const MAX_BOTS = 500
const MAX_DEPTH = 32
const MAX_MESSAGES = 100_000
const MAX_TOKENS = 10_000_000
const MAX_COST_UNITS = 1_000_000
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u

export class ManagerPolicyError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ManagerPolicyError'
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizeTerms(values: readonly string[]): string[] {
  return [...new Set(values
    .flatMap(value => value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u))
    .map(value => value.trim())
    .filter(value => value.length >= 2))]
}

function ensureText(value: string, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ManagerPolicyError('MANAGER_INVALID_INPUT', `${label} is required`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new ManagerPolicyError('MANAGER_INPUT_TOO_LARGE', `${label} exceeds ${maximum} characters`)
  return normalized
}

function normalizeBudget(input: Partial<ManagerBudget> | undefined): ManagerBudget {
  const raw = { ...DEFAULT_MANAGER_BUDGET, ...(input ?? {}) }
  const integer = (value: number, label: string, minimum: number, maximum: number): number => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new ManagerPolicyError('MANAGER_BUDGET_INVALID', `${label} must be an integer between ${minimum} and ${maximum}`)
    return value
  }
  const maxParallelRuns = integer(raw.maxParallelRuns, 'maxParallelRuns', 1, MAX_BOTS)
  const maxFanOut = integer(raw.maxFanOut, 'maxFanOut', 1, MAX_BOTS)
  const maxBots = integer(raw.maxBots, 'maxBots', 1, MAX_BOTS)
  return {
    maxBots: Math.min(maxBots, maxParallelRuns, maxFanOut),
    maxParallelRuns,
    maxDepth: integer(raw.maxDepth, 'maxDepth', 1, MAX_DEPTH),
    maxMessages: integer(raw.maxMessages, 'maxMessages', 1, MAX_MESSAGES),
    maxTokens: integer(raw.maxTokens, 'maxTokens', 1, MAX_TOKENS),
    maxCostUnits: integer(raw.maxCostUnits, 'maxCostUnits', 1, MAX_COST_UNITS),
    maxFanOut,
    maxHops: integer(raw.maxHops, 'maxHops', 0, MAX_DEPTH),
  }
}

function normalizeBot(bot: ManagerBotDescriptor): ManagerBotDescriptor {
  const id = ensureText(bot.id, 'Bot id', 64).toLowerCase()
  if (!BOT_ID_PATTERN.test(id)) throw new ManagerPolicyError('MANAGER_INVALID_BOT', `Invalid Bot id: ${id}`)
  if (!Array.isArray(bot.capabilities) || bot.capabilities.length > 200) throw new ManagerPolicyError('MANAGER_INVALID_BOT', `Invalid capabilities for Bot ${id}`)
  return {
    ...clone(bot),
    id,
    capabilities: normalizeTerms(bot.capabilities),
    skills: normalizeTerms(bot.skills ?? []),
    inFlight: bot.inFlight === undefined ? 0 : Math.max(0, bot.inFlight),
    ...(bot.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, bot.confidence)) }),
  }
}

function statusOf(bot: ManagerBotDescriptor): NonNullable<ManagerBotDescriptor['status']> {
  return bot.status ?? 'available'
}

function isEligible(bot: ManagerBotDescriptor, managerBotId: string, budget: ManagerBudget): boolean {
  if (bot.id === managerBotId.toLowerCase()) return false
  if (!bot.enabled || !bot.authorized || bot.role === 'manager') return false
  const status = statusOf(bot)
  if (status === 'unavailable' || status === 'timeout' || status === 'failed' || status === 'low-confidence') return false
  if (bot.confidence !== undefined && bot.confidence < 0.5) return false
  return (bot.inFlight ?? 0) < budget.maxParallelRuns
}

function scoreBot(
  bot: ManagerBotDescriptor,
  required: ReadonlySet<string>,
  instructionTerms: ReadonlySet<string>,
): { readonly score: number; readonly reasons: readonly string[]; readonly coverage: readonly string[] } {
  const labels = new Set([...bot.capabilities, ...(bot.skills ?? []), ...normalizeTerms([bot.title ?? ''])])
  const coverage = [...required].filter(term => labels.has(term) || [...labels].some(label => label.includes(term) || term.includes(label)))
  const matchedTerms = [...instructionTerms].filter(term => [...labels].some(label => label.includes(term) || term.includes(label)))
  const roleBoost = bot.role === 'worker' ? 3 : bot.role === 'verifier' || bot.role === 'synthesizer' ? 1 : 0
  const confidenceBoost = bot.confidence === undefined ? 0 : Math.round(bot.confidence * 2)
  const reasons = [
    ...(coverage.length === 0 ? [] : [`capability match: ${coverage.join(', ')}`]),
    ...(matchedTerms.length === 0 ? [] : [`instruction match: ${matchedTerms.join(', ')}`]),
    ...(roleBoost === 0 ? [] : [`role:${bot.role}`]),
  ]
  return { score: coverage.length * 100 + matchedTerms.length * 10 + roleBoost + confidenceBoost, reasons, coverage }
}

function approvalFor(task: ManagerTaskInput, assignmentCount: number): ApprovalRequirement {
  const risk = task.risk ?? 'low'
  const reason: string[] = []
  if (risk === 'high') reason.push('high-risk task')
  if (task.requiresExternalEffect === true) reason.push('external effect requested')
  if (assignmentCount > 1) reason.push('multi-Bot delegation')
  const required = risk === 'high' || task.requiresExternalEffect === true
  return {
    required,
    risk,
    reason: reason.length ? reason : ['policy permits bounded delegation'],
    scope: task.requiresExternalEffect === true ? 'external-effect' : 'delegation',
  }
}

function delegationBudget(total: ManagerBudget, count: number): DelegationBudgetSlice {
  return {
    maxTokens: Math.max(1, Math.floor(total.maxTokens / count)),
    maxCostUnits: Math.max(1, Math.floor(total.maxCostUnits / count)),
    maxMessages: Math.max(1, Math.floor(total.maxMessages / count)),
    maxDepth: Math.max(1, total.maxDepth - 1),
  }
}

function buildDelegations(
  task: ManagerTaskInput,
  managerBotId: string,
  budget: ManagerBudget,
  candidates: readonly { readonly bot: ManagerBotDescriptor; readonly reasons: readonly string[] }[],
  approval: ApprovalRequirement,
): DelegationIntent[] {
  const slice = delegationBudget(budget, Math.max(1, candidates.length))
  return candidates.map((candidate, index) => ({
    intentId: `intent_${stableHash({ taskId: task.taskId, traceId: task.traceId, bot: candidate.bot.id, index })}`,
    taskId: task.taskId,
    traceId: task.traceId,
    fromManager: managerBotId,
    toBot: candidate.bot.id,
    instruction: task.instruction,
    acceptanceCriteria: [...(task.acceptanceCriteria ?? [])].slice(0, 20),
    reason: [...candidate.reasons],
    budget: slice,
    requiresApproval: approval.required,
    hop: 1,
    visitedBotIds: [managerBotId, candidate.bot.id],
  }))
}

function unavailableReasons(bots: readonly ManagerBotDescriptor[]): string[] {
  return bots.flatMap(bot => {
    const status = statusOf(bot)
    if (bot.authorized === false) return [`@${bot.id} excluded: authorization is supplied by the control plane`]
    if (!bot.enabled) return [`@${bot.id} excluded: disabled`]
    if (status === 'unavailable' || status === 'timeout' || status === 'failed' || status === 'low-confidence') return [`@${bot.id} excluded: ${status}`]
    if (bot.confidence !== undefined && bot.confidence < 0.5) return [`@${bot.id} excluded: low confidence (${bot.confidence})`]
    return []
  })
}

/**
 * Generate a bounded, inspectable plan. This function has no Gateway or
 * transport dependency and never sends a delegation or changes permissions.
 */
export function generateManagerPlan(
  task: ManagerTaskInput,
  managerBotId: string,
  availableBots: readonly ManagerBotDescriptor[],
  options: { readonly planRevision?: number; readonly now?: number } = {},
): ManagerPlan {
  try {
    assertNoCredentialMaterial(task, 'Manager task input cannot contain credential material')
  } catch {
    throw new ManagerPolicyError('MANAGER_CREDENTIAL_MATERIAL', 'Manager task input cannot contain credential material')
  }
  const taskId = ensureText(task.taskId, 'taskId', 256)
  const traceId = ensureText(task.traceId, 'traceId', 256)
  const requester = ensureText(task.requester, 'requester', 256)
  const instruction = ensureText(task.instruction, 'instruction', 20_000)
  const normalizedManagerId = ensureText(managerBotId, 'managerBotId', 64).toLowerCase()
  const budget = normalizeBudget(task.budget)
  const required = new Set(normalizeTerms(task.requiredCapabilities ?? []))
  const instructionTerms = new Set(normalizeTerms([instruction]))
  const normalizedBots = [...new Map(availableBots.map(bot => {
    const normalized = normalizeBot(bot)
    return [normalized.id, normalized] as const
  })).values()]
  const ranked = normalizedBots
    .filter(bot => isEligible(bot, normalizedManagerId, budget))
    .map(bot => ({ bot, ...scoreBot(bot, required, instructionTerms) }))
    .sort((left, right) => right.score - left.score || left.bot.id.localeCompare(right.bot.id))
  const limit = Math.min(task.maxAssignments ?? budget.maxBots, budget.maxBots, normalizedBots.length)
  const selected: typeof ranked = []
  const covered = new Set<string>()
  const remaining = [...ranked]
  let selectedCost = 0
  while (selected.length < limit && remaining.length > 0 && budget.maxHops >= 1) {
    let bestIndex = 0
    let bestGain = -1
    for (const [index, candidate] of remaining.entries()) {
      const gain = candidate.coverage.filter(capability => !covered.has(capability)).length
      const effective = gain * 1_000 + candidate.score
      if (effective > bestGain) {
        bestGain = effective
        bestIndex = index
      }
    }
    const [candidate] = remaining.splice(bestIndex, 1)
    if (candidate === undefined) break
    const candidateCost = candidate.bot.costPerRun ?? 0
    if (selectedCost + candidateCost > budget.maxCostUnits) continue
    selected.push(candidate)
    selectedCost += candidateCost
    for (const capability of candidate.coverage) covered.add(capability)
    if (required.size > 0 && covered.size === required.size && selected.length >= Math.min(2, limit)) break
  }
  const approval = approvalFor(task, selected.length)
  const reasons = [
    ...unavailableReasons(normalizedBots),
    ...(selected.length === 0 ? ['No eligible authorized Bot matched the bounded policy'] : [`Selected ${selected.length} of ${normalizedBots.length} logical Bots`]),
    ...(required.size > covered.size ? [`Missing required capabilities: ${[...required].filter(item => !covered.has(item)).join(', ')}`] : []),
  ]
  const missingRequired = required.size > covered.size
  const policyDecision = selected.length === 0 || missingRequired
    ? 'deny'
    : approval.required
      ? 'approval-required'
      : 'allow'
  const planRevision = options.planRevision ?? 1
  const planId = `plan_${stableHash({ taskId, traceId, planRevision, selected: selected.map(item => item.bot.id) })}`
  return {
    schemaVersion: 1,
    planId,
    planRevision,
    taskId,
    traceId,
    policyDecision,
    reasons,
    budget,
    delegations: buildDelegations(task, normalizedManagerId, budget, selected, approval),
    approval,
    generatedAt: options.now ?? Date.now(),
  }
}

/**
 * Produce a replacement suggestion after a worker becomes unavailable,
 * times out, fails, or falls below the confidence threshold.
 */
export function generateReplanSuggestion(input: ManagerReplanInput): ReplanSuggestion {
  try {
    assertNoCredentialMaterial(input, 'Manager replan input cannot contain credential material')
  } catch {
    throw new ManagerPolicyError('MANAGER_CREDENTIAL_MATERIAL', 'Manager replan input cannot contain credential material')
  }
  const observed = new Map(input.observations.map(item => [item.botId.toLowerCase(), item]))
  const reasons = input.observations.map(item => `@${item.botId} reported ${item.status}${item.reason === undefined ? '' : `: ${item.reason}`}`)
  const available = input.availableBots.filter(bot => !observed.has(bot.id.toLowerCase()))
  const next = generateManagerPlan(input.task, input.managerBotId, available, {
    planRevision: input.planRevision ?? input.currentPlan.planRevision + 1,
  })
  const policyDecision = next.policyDecision === 'deny'
    ? 'replan-required'
    : next.policyDecision === 'approval-required'
      ? 'approval-required'
      : 'replan-required'
  return {
    schemaVersion: 1,
    planId: next.planId,
    planRevision: next.planRevision,
    taskId: next.taskId,
    traceId: next.traceId,
    policyDecision,
    reasons: [...reasons, ...next.reasons, 'This is a suggestion only; the control plane must approve and dispatch it.'],
    replacementDelegations: next.delegations,
    approval: next.approval,
  }
}

export function managerPolicySummary(plan: ManagerPlan): string {
  return [
    `decision=${plan.policyDecision}`,
    `plan=${plan.planId}@${plan.planRevision}`,
    `task=${plan.taskId}`,
    `delegations=${plan.delegations.length}`,
    `approval=${plan.approval.required ? 'required' : 'not-required'}`,
    `budget=${plan.budget.maxParallelRuns}/${plan.budget.maxMessages}/${plan.budget.maxTokens}`,
  ].join(' ')
}
