import type {
  WorkflowCondition,
  WorkflowCompensationSpec,
  WorkflowDefinition,
  WorkflowInputBinding,
  WorkflowMapSpec,
  WorkflowNode,
  WorkflowReference,
  WorkflowReduceSpec,
  WorkflowScalar,
} from './fleet-v2-types.js'

export class WorkflowControlError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'WorkflowControlError'
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => stableJson(item)).join(',') + ']'
  return '{' + Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item))
    .join(',') + '}'
}

function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Agent output is historically persisted as text. JSON output is promoted to
 * structured data for Workflow references; non-JSON output remains a string.
 */
export function parseWorkflowResult(result: string | undefined): unknown {
  if (result === undefined) return undefined
  const trimmed = result.trim()
  if (trimmed === '') return ''
  try {
    return clone(JSON.parse(trimmed))
  } catch {
    return result
  }
}

/**
 * Resolve an output name from either structured JSON or legacy text.
 * The result output is the whole value; named outputs read object keys.
 */
export function selectWorkflowOutput(value: unknown, output: string): unknown {
  if (output === 'result') return clone(value)
  if (isRecord(value) && Object.hasOwn(value, output)) return clone(value[output])
  return undefined
}

export function resolveWorkflowReference(
  reference: WorkflowReference,
  inputs: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  if (reference.kind === 'input') return clone(inputs[reference.name])
  if (reference.kind === 'constant') return clone(reference.value)
  const source = outputs.get(reference.nodeId)
  if (source === undefined) return undefined
  return selectWorkflowOutput(source, reference.output)
}

export function resolveWorkflowInputs(
  node: Pick<WorkflowNode, 'inputs'>,
  launchInputs: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
  override?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const binding of node.inputs ?? []) {
    const value = resolveWorkflowReference(binding.source, launchInputs, outputs)
    if (value !== undefined) resolved[binding.name] = clone(value)
  }
  if (override !== undefined) {
    for (const [name, value] of Object.entries(override)) resolved[name] = clone(value)
  }
  return resolved
}

function contains(value: unknown, expected: WorkflowScalar | undefined): boolean {
  if (typeof value === 'string') return expected !== undefined && value.includes(String(expected))
  if (Array.isArray(value)) return value.some(item => equal(item, expected))
  if (isRecord(value)) return expected !== undefined && Object.hasOwn(value, String(expected))
  return false
}

function truthy(value: unknown): boolean {
  return Boolean(value)
}

export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  inputs: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
): { readonly value: unknown; readonly matched: boolean } {
  const value = resolveWorkflowReference(condition.source, inputs, outputs)
  const matched = condition.operator === 'equals'
    ? equal(value, condition.value)
    : condition.operator === 'not-equals'
      ? !equal(value, condition.value)
      : condition.operator === 'exists'
        ? value !== undefined && value !== null
        : condition.operator === 'truthy'
          ? truthy(value)
          : contains(value, condition.value)
  return { value: clone(value), matched }
}

export function mapWorkflowValues(
  spec: WorkflowMapSpec,
  inputs: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
  budgetMaxFanOut: number,
): readonly unknown[] {
  const source = resolveWorkflowReference(spec.source, inputs, outputs)
  if (!Array.isArray(source)) {
    throw new WorkflowControlError('WORKFLOW_MAP_SOURCE_NOT_ARRAY', 'Map source must resolve to an array')
  }
  const requested = spec.maxFanOut ?? source.length
  const limit = Math.min(requested, budgetMaxFanOut)
  if (source.length > limit) {
    throw new WorkflowControlError('WORKFLOW_MAP_FANOUT_EXCEEDED', 'Map source exceeds the Workflow fan-out budget')
  }
  return source.map(item => clone(item))
}

function successful(value: unknown): boolean {
  if (isRecord(value)) {
    if (typeof value.status === 'string') return ['completed', 'success', 'succeeded', 'ok'].includes(value.status.toLowerCase())
    if (value.error !== undefined && value.error !== null && String(value.error) !== '') return false
  }
  return value !== undefined && value !== null
}

export function reduceWorkflowValues(
  spec: WorkflowReduceSpec,
  inputs: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  const source = resolveWorkflowReference(spec.source, inputs, outputs)
  const values = Array.isArray(source) ? source : source === undefined ? [] : [source]
  switch (spec.reducer) {
    case 'concat':
      return values.flatMap(value => Array.isArray(value) ? value.map(item => clone(item)) : [clone(value)])
    case 'first-success':
      return clone(values.find(value => successful(value)))
    case 'all-success':
      return values.every(value => successful(value))
    case 'count':
      return values.length
  }
}

export function serializeWorkflowResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/**
 * A compensation node is selected once for each completed node, in reverse
 * completion order. The caller persists/dispatches the returned IDs and
 * remains responsible for authorization and idempotency.
 */
export function compensationNodeIds(
  definition: WorkflowDefinition,
  completedNodeIds: readonly string[],
  trigger: WorkflowCompensationSpec['on'],
): readonly string[] {
  const byId = new Map(definition.nodes.map(node => [node.id, node]))
  const result: string[] = []
  const seen = new Set<string>()
  for (const sourceId of [...completedNodeIds].reverse()) {
    const compensation = byId.get(sourceId)?.compensation
    if (compensation?.on !== trigger || seen.has(compensation.nodeId)) continue
    if (!byId.has(compensation.nodeId)) {
      throw new WorkflowControlError('WORKFLOW_COMPENSATION_TARGET_MISSING', 'Compensation target is missing: ' + compensation.nodeId)
    }
    seen.add(compensation.nodeId)
    result.push(compensation.nodeId)
  }
  return result
}

export function workflowBindingNames(bindings: readonly WorkflowInputBinding[] | undefined): readonly string[] {
  return [...new Set((bindings ?? []).map(binding => binding.name))]
}
