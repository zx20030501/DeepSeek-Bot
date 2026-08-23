import { assertNoCredentialMaterial } from './credential-scan.js'
import {
  FLEET_V2_SCHEMA_VERSION,
  type WorkflowApprovalSpec,
  type WorkflowBudget,
  type WorkflowCompensationSpec,
  type WorkflowCondition,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowEdge,
  type WorkflowEffectDeclaration,
  type WorkflowInputBinding,
  type WorkflowInputDefinition,
  type WorkflowMapSpec,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowOutputDefinition,
  type WorkflowPolicy,
  type WorkflowReference,
  type WorkflowReduceSpec,
  type WorkflowRetrySpec,
  type WorkflowScalar,
  type WorkflowTimeoutSpec,
  type WorkflowValidationErrorCode,
  type WorkflowValidationResult,
  type WorkflowValueType,
} from './fleet-v2-types.js'

const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const FIELD_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u
const NODE_KINDS: ReadonlySet<WorkflowNodeKind> = new Set([
  'task',
  'sequential',
  'parallel',
  'condition',
  'map',
  'reduce',
  'approval',
  'retry',
  'timeout',
  'compensation',
])
const SCALAR_TYPES: ReadonlySet<WorkflowValueType> = new Set(['string', 'number', 'boolean', 'object', 'array', 'unknown'])
const EFFECT_KINDS: ReadonlySet<WorkflowEffectDeclaration['kind']> = new Set([
  'none',
  'task-dispatch',
  'message-send',
  'file-write',
  'network-request',
])
const APPROVAL_RISKS: ReadonlySet<WorkflowApprovalSpec['risk']> = new Set(['low', 'medium', 'high'])
const APPROVAL_ACTORS: ReadonlySet<WorkflowApprovalSpec['requestedBy']> = new Set(['requester', 'operator', 'policy'])
const REDUCERS: ReadonlySet<WorkflowReduceSpec['reducer']> = new Set(['concat', 'first-success', 'all-success', 'count'])
const CONDITION_OPERATORS: ReadonlySet<WorkflowCondition['operator']> = new Set([
  'equals',
  'not-equals',
  'exists',
  'truthy',
  'contains',
])

const MAX_NODES = 1_000
const MAX_INPUTS = 200
const MAX_OUTPUTS = 200
const MAX_EDGES = 4_000
const MAX_DEPTH = 128
const MAX_FAN_OUT = 10_000
const MAX_MESSAGES = 100_000
const MAX_TOKENS = 10_000_000
const MAX_COST_UNITS = 1_000_000
const MAX_TEXT = 20_000

const WORKFLOW_KEYS = new Set([
  'schemaVersion',
  'id',
  'revision',
  'status',
  'createdAt',
  'updatedAt',
  'name',
  'description',
  'ownerId',
  'scope',
  'workspaceId',
  'tags',
  'entryNodeId',
  'nodes',
  'edges',
  'inputs',
  'outputs',
  'policy',
])
const NODE_KEYS = new Set([
  'id',
  'label',
  'kind',
  'dependsOn',
  'children',
  'inputs',
  'outputs',
  'capability',
  'permissions',
  'effect',
  'costUnits',
  'tokenBudget',
  'messageBudget',
  'maxConcurrency',
  'condition',
  'map',
  'reduce',
  'approval',
  'retry',
  'timeout',
  'compensation',
])

export const DEFAULT_WORKFLOW_BUDGET: WorkflowBudget = {
  maxDepth: 12,
  maxParallel: 6,
  maxFanOut: 100,
  maxMessages: 100,
  maxTokens: 200_000,
  maxCostUnits: 10_000,
}

export interface WorkflowDraftValidationResult {
  readonly ok: boolean
  readonly diagnostics: readonly import('./fleet-v2-types.js').WorkflowDiagnostic[]
  readonly draft?: WorkflowDraft
}

export class WorkflowValidationError extends Error {
  public readonly code: WorkflowValidationErrorCode
  public readonly diagnostics: readonly import('./fleet-v2-types.js').WorkflowDiagnostic[]

  public constructor(
    code: WorkflowValidationErrorCode,
    message: string,
    diagnostics: readonly import('./fleet-v2-types.js').WorkflowDiagnostic[] = [],
  ) {
    super(message)
    this.name = 'WorkflowValidationError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function diagnostic(
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  code: WorkflowValidationErrorCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message })
}

function hasOnlyKeys(value: RecordValue, allowed: ReadonlySet<string>, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.${key}`, 'Unknown field is not allowed')
  }
}

function text(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  options: { readonly required?: boolean; readonly maximum?: number } = {},
): string | undefined {
  if (typeof value !== 'string') {
    if (options.required || value !== undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a string')
    return undefined
  }
  const normalized = value.trim()
  if (!normalized) {
    if (options.required) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Value must not be empty')
    return undefined
  }
  if (normalized.length > (options.maximum ?? MAX_TEXT)) {
    diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', path, `Text exceeds the ${options.maximum ?? MAX_TEXT} character limit`)
    return undefined
  }
  if (/(?:javascript\s*:|<script\b|(?:^|[\s("'=])(?:eval|new\s+Function|Function)\s*\(|(?:^|[\s("'=])(?:node\s+-{1,2}e|bash\s+-c|sh\s+-c|powershell(?:\.exe)?\s+-|cmd(?:\.exe)?\s+\/c)(?:\s|$))/iu.test(normalized)) {
    diagnostic(diagnostics, 'WORKFLOW_UNSAFE_INPUT', path, 'Executable JavaScript or shell input is not allowed in a Workflow definition')
  }
  return normalized
}

function id(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  field = false,
): string | undefined {
  const candidate = text(value, path, diagnostics, { required: true, maximum: 128 })
  if (candidate !== undefined && !(field ? FIELD_ID_PATTERN : WORKFLOW_ID_PATTERN).test(candidate)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_ID', path, `Invalid ${field ? 'field' : 'workflow'} identifier`)
    return undefined
  }
  return candidate
}

function finiteInteger(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  minimum: number,
  maximum: number,
  required = true,
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    if (required || value !== undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected an integer')
    return undefined
  }
  if (value < minimum || value > maximum) {
    diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', path, `Value must be between ${minimum} and ${maximum}`)
    return undefined
  }
  return value
}

function booleanValue(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  required = false,
): boolean | undefined {
  if (typeof value !== 'boolean') {
    if (required || value !== undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a boolean')
    return undefined
  }
  return value
}

function stringList(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  maximum: number,
  field = false,
): string[] | undefined {
  if (!Array.isArray(value)) {
    if (value !== undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected an array of strings')
    return undefined
  }
  if (value.length > maximum) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', path, `List exceeds the ${maximum} item limit`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const candidate = id(item, `${path}[${index}]`, diagnostics, field)
    if (candidate === undefined) continue
    if (seen.has(candidate)) diagnostic(diagnostics, 'WORKFLOW_DUPLICATE_NAME', `${path}[${index}]`, 'Duplicate value')
    else {
      seen.add(candidate)
      result.push(candidate)
    }
  }
  return result
}

function scalar(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowScalar | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string') text(value, path, diagnostics, { maximum: MAX_TEXT })
    return value as WorkflowScalar
  }
  diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Only JSON scalar constants are allowed')
  return undefined
}

function parseReference(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
): WorkflowReference | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a structured Workflow reference')
    return undefined
  }
  const kind = value.kind
  if (kind === 'input') {
    hasOnlyKeys(value, new Set(['kind', 'name']), path, diagnostics)
    const name = id(value.name, `${path}.name`, diagnostics, true)
    return name === undefined ? undefined : { kind: 'input', name }
  }
  if (kind === 'node-output') {
    hasOnlyKeys(value, new Set(['kind', 'nodeId', 'output']), path, diagnostics)
    const nodeId = id(value.nodeId, `${path}.nodeId`, diagnostics)
    const output = id(value.output, `${path}.output`, diagnostics, true)
    return nodeId === undefined || output === undefined ? undefined : { kind: 'node-output', nodeId, output }
  }
  if (kind === 'constant') {
    hasOnlyKeys(value, new Set(['kind', 'value']), path, diagnostics)
    const constant = scalar(value.value, `${path}.value`, diagnostics)
    return constant === undefined ? undefined : { kind: 'constant', value: constant }
  }
  diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.kind`, 'Unknown reference kind')
  return undefined
}

function parseInputBinding(
  value: unknown,
  path: string,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
): WorkflowInputBinding | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected an input binding')
    return undefined
  }
  hasOnlyKeys(value, new Set(['name', 'source']), path, diagnostics)
  const name = id(value.name, `${path}.name`, diagnostics, true)
  const source = parseReference(value.source, `${path}.source`, diagnostics)
  return name === undefined || source === undefined ? undefined : { name, source }
}

function parseInputDefinitions(value: unknown, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowInputDefinition[] {
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'inputs', 'Workflow inputs must be an array')
    return []
  }
  if (value.length > MAX_INPUTS) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', 'inputs', `A Workflow may have at most ${MAX_INPUTS} inputs`)
  const result: WorkflowInputDefinition[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const path = `inputs[${index}]`
    if (!isRecord(raw)) {
      diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected an input definition')
      continue
    }
    hasOnlyKeys(raw, new Set(['name', 'type', 'required', 'description']), path, diagnostics)
    const name = id(raw.name, `${path}.name`, diagnostics, true)
    const type = text(raw.type, `${path}.type`, diagnostics, { required: true, maximum: 32 }) as WorkflowValueType | undefined
    if (type !== undefined && !SCALAR_TYPES.has(type)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.type`, 'Unsupported Workflow input type')
    const required = booleanValue(raw.required, `${path}.required`, diagnostics)
    const description = text(raw.description, `${path}.description`, diagnostics)
    if (name === undefined || type === undefined) continue
    if (seen.has(name)) diagnostic(diagnostics, 'WORKFLOW_DUPLICATE_NAME', `${path}.name`, 'Duplicate Workflow input name')
    else {
      seen.add(name)
      result.push({ name, type: type as WorkflowValueType, ...(required === undefined ? {} : { required }), ...(description === undefined ? {} : { description }) })
    }
  }
  return result
}

function parseOutputs(value: unknown, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowOutputDefinition[] {
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'outputs', 'Workflow outputs must be an array')
    return []
  }
  if (value.length > MAX_OUTPUTS) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', 'outputs', `A Workflow may have at most ${MAX_OUTPUTS} outputs`)
  const result: WorkflowOutputDefinition[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const path = `outputs[${index}]`
    if (!isRecord(raw)) {
      diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a Workflow output definition')
      continue
    }
    hasOnlyKeys(raw, new Set(['name', 'source', 'description']), path, diagnostics)
    const name = id(raw.name, `${path}.name`, diagnostics, true)
    const source = parseReference(raw.source, `${path}.source`, diagnostics)
    const description = text(raw.description, `${path}.description`, diagnostics)
    if (name === undefined || source === undefined) continue
    if (seen.has(name)) diagnostic(diagnostics, 'WORKFLOW_DUPLICATE_NAME', `${path}.name`, 'Duplicate Workflow output name')
    else {
      seen.add(name)
      result.push({ name, source, ...(description === undefined ? {} : { description }) })
    }
  }
  return result
}

function parseEffect(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowEffectDeclaration | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected an effect declaration')
    return undefined
  }
  hasOnlyKeys(value, new Set(['kind', 'declaration', 'targetCapability']), path, diagnostics)
  const kind = text(value.kind, `${path}.kind`, diagnostics, { required: true, maximum: 32 }) as WorkflowEffectDeclaration['kind'] | undefined
  const declaration = text(value.declaration, `${path}.declaration`, diagnostics, { maximum: 500 })
  const targetCapability = id(value.targetCapability, `${path}.targetCapability`, diagnostics, true)
  if (kind === undefined || !EFFECT_KINDS.has(kind)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.kind`, 'Unsupported Workflow effect kind')
    return undefined
  }
  if (kind !== 'none' && declaration === undefined) {
    diagnostic(diagnostics, 'WORKFLOW_EXTERNAL_EFFECT_UNDECLARED', path, 'External effects require a human-readable declaration')
  }
  return {
    kind,
    ...(declaration === undefined ? {} : { declaration }),
    ...(targetCapability === undefined ? {} : { targetCapability }),
  }
}

function parseCondition(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowCondition | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Condition node requires a condition object')
    return undefined
  }
  hasOnlyKeys(value, new Set(['source', 'operator', 'value', 'whenTrue', 'whenFalse']), path, diagnostics)
  const source = parseReference(value.source, `${path}.source`, diagnostics)
  const operator = text(value.operator, `${path}.operator`, diagnostics, { required: true, maximum: 32 }) as WorkflowCondition['operator'] | undefined
  if (operator !== undefined && !CONDITION_OPERATORS.has(operator)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.operator`, 'Unsupported condition operator')
  const conditionValue = value.value === undefined ? undefined : scalar(value.value, `${path}.value`, diagnostics)
  const whenTrue = id(value.whenTrue, `${path}.whenTrue`, diagnostics)
  const whenFalse = value.whenFalse === undefined ? undefined : id(value.whenFalse, `${path}.whenFalse`, diagnostics)
  return source === undefined || operator === undefined || whenTrue === undefined
    ? undefined
    : { source, operator, ...(conditionValue === undefined ? {} : { value: conditionValue }), whenTrue, ...(whenFalse === undefined ? {} : { whenFalse }) }
}

function parseMap(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowMapSpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Map node requires a map specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['source', 'itemInput', 'templateNodeId', 'maxFanOut']), path, diagnostics)
  const source = parseReference(value.source, `${path}.source`, diagnostics)
  const itemInput = id(value.itemInput, `${path}.itemInput`, diagnostics, true)
  const templateNodeId = id(value.templateNodeId, `${path}.templateNodeId`, diagnostics)
  const maxFanOut = finiteInteger(value.maxFanOut, `${path}.maxFanOut`, diagnostics, 1, MAX_FAN_OUT, false)
  return source === undefined || itemInput === undefined || templateNodeId === undefined
    ? undefined
    : { source, itemInput, templateNodeId, ...(maxFanOut === undefined ? {} : { maxFanOut }) }
}

function parseReduce(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowReduceSpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Reduce node requires a reduce specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['source', 'reducer', 'outputName']), path, diagnostics)
  const source = parseReference(value.source, `${path}.source`, diagnostics)
  const reducer = text(value.reducer, `${path}.reducer`, diagnostics, { required: true, maximum: 32 }) as WorkflowReduceSpec['reducer'] | undefined
  if (reducer !== undefined && !REDUCERS.has(reducer)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.reducer`, 'Unsupported reduce operator')
  const outputName = value.outputName === undefined ? undefined : id(value.outputName, `${path}.outputName`, diagnostics, true)
  return source === undefined || reducer === undefined
    ? undefined
    : { source, reducer, ...(outputName === undefined ? {} : { outputName }) }
}

function parseApproval(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowApprovalSpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Approval node requires an approval specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['risk', 'requestedBy', 'reason']), path, diagnostics)
  const risk = text(value.risk, `${path}.risk`, diagnostics, { required: true, maximum: 16 }) as WorkflowApprovalSpec['risk'] | undefined
  const requestedBy = text(value.requestedBy, `${path}.requestedBy`, diagnostics, { required: true, maximum: 16 }) as WorkflowApprovalSpec['requestedBy'] | undefined
  const reason = text(value.reason, `${path}.reason`, diagnostics, { required: true, maximum: 2_000 })
  if (risk !== undefined && !APPROVAL_RISKS.has(risk)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.risk`, 'Unsupported approval risk')
  if (requestedBy !== undefined && !APPROVAL_ACTORS.has(requestedBy)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.requestedBy`, 'Unsupported approval actor')
  return risk === undefined || requestedBy === undefined || reason === undefined ? undefined : { risk, requestedBy, reason }
}

function parseRetry(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowRetrySpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Retry node requires a retry specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['maxAttempts', 'backoffMs']), path, diagnostics)
  const maxAttempts = finiteInteger(value.maxAttempts, `${path}.maxAttempts`, diagnostics, 1, 20)
  const backoffMs = finiteInteger(value.backoffMs, `${path}.backoffMs`, diagnostics, 0, 3_600_000, false)
  return maxAttempts === undefined ? undefined : { maxAttempts, ...(backoffMs === undefined ? {} : { backoffMs }) }
}

function parseTimeout(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowTimeoutSpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Timeout node requires a timeout specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['timeoutMs']), path, diagnostics)
  const timeoutMs = finiteInteger(value.timeoutMs, `${path}.timeoutMs`, diagnostics, 1, 86_400_000)
  return timeoutMs === undefined ? undefined : { timeoutMs }
}

function parseCompensation(value: unknown, path: string, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowCompensationSpec | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Compensation node requires a compensation specification')
    return undefined
  }
  hasOnlyKeys(value, new Set(['nodeId', 'on']), path, diagnostics)
  const nodeId = id(value.nodeId, `${path}.nodeId`, diagnostics)
  const on = text(value.on, `${path}.on`, diagnostics, { required: true, maximum: 16 }) as WorkflowCompensationSpec['on'] | undefined
  if (on !== undefined && on !== 'failure' && on !== 'cancel' && on !== 'timeout') diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.on`, 'Unsupported compensation trigger')
  return nodeId === undefined || on === undefined ? undefined : { nodeId, on }
}

function parseNode(value: unknown, index: number, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowNode | undefined {
  const path = `nodes[${index}]`
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a Workflow node')
    return undefined
  }
  hasOnlyKeys(value, NODE_KEYS, path, diagnostics)
  const nodeId = id(value.id, `${path}.id`, diagnostics)
  const label = text(value.label, `${path}.label`, diagnostics, { required: true, maximum: 160 })
  const kind = text(value.kind, `${path}.kind`, diagnostics, { required: true, maximum: 32 }) as WorkflowNodeKind | undefined
  if (kind !== undefined && !NODE_KINDS.has(kind)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.kind`, 'Unsupported Workflow node kind')
  const dependsOn = stringList(value.dependsOn, `${path}.dependsOn`, diagnostics, MAX_NODES)
  const children = stringList(value.children, `${path}.children`, diagnostics, MAX_NODES)
  const outputs = stringList(value.outputs, `${path}.outputs`, diagnostics, MAX_OUTPUTS, true)
  const permissions = stringList(value.permissions, `${path}.permissions`, diagnostics, MAX_OUTPUTS, true)
  const capability = value.capability === undefined ? undefined : id(value.capability, `${path}.capability`, diagnostics, true)
  const costUnits = finiteInteger(value.costUnits, `${path}.costUnits`, diagnostics, 0, MAX_COST_UNITS, false)
  const tokenBudget = finiteInteger(value.tokenBudget, `${path}.tokenBudget`, diagnostics, 0, MAX_TOKENS, false)
  const messageBudget = finiteInteger(value.messageBudget, `${path}.messageBudget`, diagnostics, 0, MAX_MESSAGES, false)
  const maxConcurrency = finiteInteger(value.maxConcurrency, `${path}.maxConcurrency`, diagnostics, 1, 500, false)
  const inputs = value.inputs === undefined
    ? undefined
    : Array.isArray(value.inputs)
      ? value.inputs.map((item, inputIndex) => parseInputBinding(item, `${path}.inputs[${inputIndex}]`, diagnostics)).filter((item): item is WorkflowInputBinding => item !== undefined)
      : (diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.inputs`, 'Node inputs must be an array'), undefined)
  const effect = parseEffect(value.effect, `${path}.effect`, diagnostics)
  const condition = value.condition === undefined ? undefined : parseCondition(value.condition, `${path}.condition`, diagnostics)
  const map = value.map === undefined ? undefined : parseMap(value.map, `${path}.map`, diagnostics)
  const reduce = value.reduce === undefined ? undefined : parseReduce(value.reduce, `${path}.reduce`, diagnostics)
  const approval = value.approval === undefined ? undefined : parseApproval(value.approval, `${path}.approval`, diagnostics)
  const retry = value.retry === undefined ? undefined : parseRetry(value.retry, `${path}.retry`, diagnostics)
  const timeout = value.timeout === undefined ? undefined : parseTimeout(value.timeout, `${path}.timeout`, diagnostics)
  const compensation = value.compensation === undefined ? undefined : parseCompensation(value.compensation, `${path}.compensation`, diagnostics)
  if (kind === 'task' && capability === undefined) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', `${path}.capability`, 'Task nodes must declare a capability')
  if ((kind === 'sequential' || kind === 'parallel') && (!children || children.length === 0)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.children`, `${kind} nodes must declare at least one child`)
  if (kind === 'condition' && condition === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.condition`, 'Condition nodes must declare a condition')
  if (kind === 'map' && map === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.map`, 'Map nodes must declare a map specification')
  if (kind === 'reduce' && reduce === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.reduce`, 'Reduce nodes must declare a reduce specification')
  if (kind === 'approval' && approval === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.approval`, 'Approval nodes must declare an approval specification')
  if (kind === 'retry' && retry === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.retry`, 'Retry nodes must declare a retry specification')
  if (kind === 'timeout' && timeout === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.timeout`, 'Timeout nodes must declare a timeout specification')
  if (kind === 'compensation' && compensation === undefined) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `${path}.compensation`, 'Compensation nodes must declare a compensation specification')
  if (nodeId === undefined || label === undefined || kind === undefined) return undefined
  return {
    id: nodeId,
    label,
    kind,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(children === undefined ? {} : { children }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(capability === undefined ? {} : { capability }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(effect === undefined ? {} : { effect }),
    ...(costUnits === undefined ? {} : { costUnits }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(messageBudget === undefined ? {} : { messageBudget }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(condition === undefined ? {} : { condition }),
    ...(map === undefined ? {} : { map }),
    ...(reduce === undefined ? {} : { reduce }),
    ...(approval === undefined ? {} : { approval }),
    ...(retry === undefined ? {} : { retry }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(compensation === undefined ? {} : { compensation }),
  }
}

function parseEdges(value: unknown, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowEdge[] {
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'edges', 'Workflow edges must be an array')
    return []
  }
  if (value.length > MAX_EDGES) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', 'edges', `A Workflow may have at most ${MAX_EDGES} edges`)
  const result: WorkflowEdge[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const path = `edges[${index}]`
    if (!isRecord(raw)) {
      diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', path, 'Expected a Workflow edge')
      continue
    }
    hasOnlyKeys(raw, new Set(['from', 'to', 'label']), path, diagnostics)
    const from = id(raw.from, `${path}.from`, diagnostics)
    const to = id(raw.to, `${path}.to`, diagnostics)
    const label = text(raw.label, `${path}.label`, diagnostics, { maximum: 160 })
    if (from === undefined || to === undefined) continue
    const key = `${from}\u0000${to}`
    if (seen.has(key)) diagnostic(diagnostics, 'WORKFLOW_DUPLICATE_ID', path, 'Duplicate Workflow edge')
    else {
      seen.add(key)
      result.push({ from, to, ...(label === undefined ? {} : { label }) })
    }
  }
  return result
}

function parsePolicy(value: unknown, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): WorkflowPolicy | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'policy', 'Workflow policy is required')
    return undefined
  }
  hasOnlyKeys(value, new Set(['budget', 'allowedCapabilities', 'allowedPermissions', 'allowExternalEffects', 'approvalRequiredFor']), 'policy', diagnostics)
  const budgetValue = value.budget
  if (!isRecord(budgetValue)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'policy.budget', 'Workflow policy budget is required')
    return undefined
  }
  hasOnlyKeys(budgetValue, new Set(['maxDepth', 'maxParallel', 'maxFanOut', 'maxMessages', 'maxTokens', 'maxCostUnits']), 'policy.budget', diagnostics)
  const budget: WorkflowBudget = {
    maxDepth: finiteInteger(budgetValue.maxDepth, 'policy.budget.maxDepth', diagnostics, 1, MAX_DEPTH) ?? DEFAULT_WORKFLOW_BUDGET.maxDepth,
    maxParallel: finiteInteger(budgetValue.maxParallel, 'policy.budget.maxParallel', diagnostics, 1, 500) ?? DEFAULT_WORKFLOW_BUDGET.maxParallel,
    maxFanOut: finiteInteger(budgetValue.maxFanOut, 'policy.budget.maxFanOut', diagnostics, 1, MAX_FAN_OUT) ?? DEFAULT_WORKFLOW_BUDGET.maxFanOut,
    maxMessages: finiteInteger(budgetValue.maxMessages, 'policy.budget.maxMessages', diagnostics, 1, MAX_MESSAGES) ?? DEFAULT_WORKFLOW_BUDGET.maxMessages,
    maxTokens: finiteInteger(budgetValue.maxTokens, 'policy.budget.maxTokens', diagnostics, 1, MAX_TOKENS) ?? DEFAULT_WORKFLOW_BUDGET.maxTokens,
    maxCostUnits: finiteInteger(budgetValue.maxCostUnits, 'policy.budget.maxCostUnits', diagnostics, 1, MAX_COST_UNITS) ?? DEFAULT_WORKFLOW_BUDGET.maxCostUnits,
  }
  const allowedCapabilities = stringList(value.allowedCapabilities, 'policy.allowedCapabilities', diagnostics, MAX_OUTPUTS, true)
  const allowedPermissions = stringList(value.allowedPermissions, 'policy.allowedPermissions', diagnostics, MAX_OUTPUTS, true)
  const allowExternalEffects = booleanValue(value.allowExternalEffects, 'policy.allowExternalEffects', diagnostics)
  const approvalRequiredFor = value.approvalRequiredFor === undefined
    ? undefined
    : Array.isArray(value.approvalRequiredFor)
      ? value.approvalRequiredFor.map((item, index) => {
        const parsed = text(item, `policy.approvalRequiredFor[${index}]`, diagnostics, { required: true, maximum: 32 }) as WorkflowPolicy['approvalRequiredFor'] extends readonly (infer T)[] ? T : never
        if (parsed !== 'external-effect' && parsed !== 'high-risk' && parsed !== 'high-cost') diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', `policy.approvalRequiredFor[${index}]`, 'Unsupported approval policy')
        return parsed
      })
      : (diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'policy.approvalRequiredFor', 'Expected an array'), undefined)
  return {
    budget,
    ...(allowedCapabilities === undefined ? {} : { allowedCapabilities }),
    ...(allowedPermissions === undefined ? {} : { allowedPermissions }),
    ...(allowExternalEffects === undefined ? {} : { allowExternalEffects }),
    ...(approvalRequiredFor === undefined ? {} : { approvalRequiredFor }),
  }
}

function workflowBase(
  input: RecordValue,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
  full: boolean,
): WorkflowDraft | WorkflowDefinition | undefined {
  hasOnlyKeys(input, WORKFLOW_KEYS, '', diagnostics)
  if (input.schemaVersion !== undefined && input.schemaVersion !== FLEET_V2_SCHEMA_VERSION) {
    diagnostic(diagnostics, 'WORKFLOW_UNSUPPORTED_SCHEMA', 'schemaVersion', `Only schemaVersion ${FLEET_V2_SCHEMA_VERSION} is supported`)
  }
  if (full && input.schemaVersion !== FLEET_V2_SCHEMA_VERSION) diagnostic(diagnostics, 'WORKFLOW_UNSUPPORTED_SCHEMA', 'schemaVersion', 'A full Workflow definition must include the supported schemaVersion')
  const name = text(input.name, 'name', diagnostics, { required: true, maximum: 120 })
  const description = text(input.description, 'description', diagnostics, { maximum: 4_000 })
  const ownerId = text(input.ownerId, 'ownerId', diagnostics, { required: true, maximum: 256 })
  const scope = text(input.scope, 'scope', diagnostics, { required: true, maximum: 32 }) as WorkflowDraft['scope'] | undefined
  if (scope !== 'user' && scope !== 'workspace' && scope !== 'shared') diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'scope', 'Unsupported Workflow scope')
  const workspaceId = text(input.workspaceId, 'workspaceId', diagnostics, { maximum: 256 })
  if (scope === 'workspace' && workspaceId === undefined) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', 'workspaceId', 'Workspace-scoped Workflows must declare workspaceId')
  if (scope !== 'workspace' && workspaceId !== undefined) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', 'workspaceId', 'workspaceId is only valid for workspace-scoped Workflows')
  const tags = stringList(input.tags, 'tags', diagnostics, 32, true)
  const entryNodeId = id(input.entryNodeId, 'entryNodeId', diagnostics)
  const rawNodes = input.nodes
  if (!Array.isArray(rawNodes)) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'nodes', 'Workflow nodes must be an array')
  if (Array.isArray(rawNodes) && rawNodes.length > MAX_NODES) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', 'nodes', `A Workflow may have at most ${MAX_NODES} nodes`)
  const nodes = Array.isArray(rawNodes)
    ? rawNodes.map((item, index) => parseNode(item, index, diagnostics)).filter((item): item is WorkflowNode => item !== undefined)
    : []
  const edges = parseEdges(input.edges, diagnostics)
  const inputs = parseInputDefinitions(input.inputs, diagnostics)
  const outputs = parseOutputs(input.outputs, diagnostics)
  const policy = parsePolicy(input.policy, diagnostics)
  if (full) {
    const workflowId = id(input.id, 'id', diagnostics)
    const revision = finiteInteger(input.revision, 'revision', diagnostics, 1, Number.MAX_SAFE_INTEGER)
    const status = text(input.status, 'status', diagnostics, { required: true, maximum: 16 }) as WorkflowDefinition['status'] | undefined
    if (status !== 'active' && status !== 'deleted') diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'status', 'Unsupported Workflow status')
    const createdAt = finiteInteger(input.createdAt, 'createdAt', diagnostics, 0, Number.MAX_SAFE_INTEGER)
    const updatedAt = finiteInteger(input.updatedAt, 'updatedAt', diagnostics, 0, Number.MAX_SAFE_INTEGER)
    if (workflowId === undefined || revision === undefined || status === undefined || createdAt === undefined || updatedAt === undefined) return undefined
    if (name === undefined || ownerId === undefined || scope === undefined || entryNodeId === undefined || policy === undefined) return undefined
    return {
      schemaVersion: FLEET_V2_SCHEMA_VERSION,
      id: workflowId,
      revision,
      status,
      createdAt,
      updatedAt,
      name,
      ...(description === undefined ? {} : { description }),
      ownerId,
      scope,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(tags === undefined ? {} : { tags }),
      entryNodeId,
      nodes,
      edges,
      inputs,
      outputs,
      policy,
    }
  }
  if (name === undefined || ownerId === undefined || scope === undefined || entryNodeId === undefined || policy === undefined) return undefined
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ownerId,
    scope,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(tags === undefined ? {} : { tags }),
    entryNodeId,
    nodes,
    edges,
    inputs,
    outputs,
    policy,
  }
}

function nodeOutputs(node: WorkflowNode): ReadonlySet<string> {
  return new Set(node.outputs === undefined || node.outputs.length === 0 ? ['result'] : node.outputs)
}

function addRelation(adjacency: Map<string, Set<string>>, from: string | undefined, to: string | undefined): void {
  if (from === undefined || to === undefined) return
  const targets = adjacency.get(from)
  targets?.add(to)
}

function validateReferencesAndGraph(
  definition: WorkflowDraft | WorkflowDefinition,
  diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[],
): void {
  const nodeMap = new Map(definition.nodes.map(node => [node.id, node]))
  const inputNames = new Set(definition.inputs.map(input => input.name))
  const adjacency = new Map(definition.nodes.map(node => [node.id, new Set<string>()]))
  const addReference = (reference: WorkflowReference | undefined, path: string, consumerNodeId?: string): void => {
    if (reference === undefined) return
    if (reference.kind === 'input') {
      if (!inputNames.has(reference.name)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_REFERENCE', path, `Unknown Workflow input: ${reference.name}`)
      return
    }
    if (reference.kind === 'constant') return
    const source = nodeMap.get(reference.nodeId)
    if (source === undefined) {
      diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_REFERENCE', path, `Unknown source node: ${reference.nodeId}`)
      return
    }
    if (!nodeOutputs(source).has(reference.output)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_REFERENCE', path, `Unknown output ${reference.output} on node ${reference.nodeId}`)
    addRelation(adjacency, reference.nodeId, consumerNodeId)
  }
  for (const [index, edge] of definition.edges.entries()) {
    if (!nodeMap.has(edge.from)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `edges[${index}].from`, `Unknown source node: ${edge.from}`)
    if (!nodeMap.has(edge.to)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `edges[${index}].to`, `Unknown target node: ${edge.to}`)
    if (nodeMap.has(edge.from) && nodeMap.has(edge.to)) addRelation(adjacency, edge.from, edge.to)
  }
  for (const [index, node] of definition.nodes.entries()) {
    const path = `nodes[${index}]`
    for (const [dependencyIndex, dependency] of (node.dependsOn ?? []).entries()) {
      if (!nodeMap.has(dependency)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `${path}.dependsOn[${dependencyIndex}]`, `Unknown dependency node: ${dependency}`)
      addRelation(adjacency, dependency, node.id)
    }
    for (const [childIndex, child] of (node.children ?? []).entries()) {
      if (!nodeMap.has(child)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `${path}.children[${childIndex}]`, `Unknown child node: ${child}`)
      addRelation(adjacency, node.id, child)
    }
    for (const [bindingIndex, binding] of (node.inputs ?? []).entries()) addReference(binding.source, `${path}.inputs[${bindingIndex}].source`, node.id)
    addReference(node.condition?.source, `${path}.condition.source`, node.id)
    addReference(node.map?.source, `${path}.map.source`, node.id)
    addReference(node.reduce?.source, `${path}.reduce.source`, node.id)
    if (node.condition !== undefined) {
      if (!nodeMap.has(node.condition.whenTrue)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `${path}.condition.whenTrue`, `Unknown condition target: ${node.condition.whenTrue}`)
      addRelation(adjacency, node.id, node.condition.whenTrue)
      if (node.condition.whenFalse !== undefined) {
        if (!nodeMap.has(node.condition.whenFalse)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `${path}.condition.whenFalse`, `Unknown condition target: ${node.condition.whenFalse}`)
        addRelation(adjacency, node.id, node.condition.whenFalse)
      }
    }
    if (node.map !== undefined) {
      if (!nodeMap.has(node.map.templateNodeId)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', `${path}.map.templateNodeId`, `Unknown map template node: ${node.map.templateNodeId}`)
      addRelation(adjacency, node.id, node.map.templateNodeId)
    }
    if (node.compensation !== undefined) {
      if (!nodeMap.has(node.compensation.nodeId)) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', path + '.compensation.nodeId', 'Unknown compensation node: ' + node.compensation.nodeId)
      else addRelation(adjacency, node.id, node.compensation.nodeId)
    }
  }
  for (const [index, output] of definition.outputs.entries()) addReference(output.source, `outputs[${index}].source`)
  const entry = nodeMap.get(definition.entryNodeId)
  if (entry === undefined) diagnostic(diagnostics, 'WORKFLOW_UNKNOWN_NODE', 'entryNodeId', `Unknown entry node: ${definition.entryNodeId}`)
  if (entry !== undefined) {
    const reachable = new Set<string>()
    const pending = [entry.id]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (reachable.has(current)) continue
      reachable.add(current)
      for (const next of adjacency.get(current) ?? []) pending.push(next)
    }
    for (const node of definition.nodes) if (!reachable.has(node.id)) diagnostic(diagnostics, 'WORKFLOW_ORPHAN_NODE', `nodes.${node.id}`, 'Node is not reachable from entryNodeId')
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const walk = (nodeId: string, path: string[]): void => {
    if (visiting.has(nodeId)) {
      diagnostic(diagnostics, 'WORKFLOW_CYCLE', `nodes.${nodeId}`, `Workflow graph contains a cycle: ${[...path, nodeId].join(' -> ')}`)
      return
    }
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) ?? []) walk(next, [...path, nodeId])
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  if (entry !== undefined) walk(entry.id, [])
  const budget = definition.policy.budget
  const depthMemo = new Map<string, number>()
  const depth = (nodeId: string, stack: ReadonlySet<string> = new Set()): number => {
    const cached = depthMemo.get(nodeId)
    if (cached !== undefined) return cached
    if (stack.has(nodeId)) return budget.maxDepth + 1
    const nextStack = new Set(stack)
    nextStack.add(nodeId)
    const value = 1 + Math.max(0, ...[...(adjacency.get(nodeId) ?? [])].map(next => depth(next, nextStack)))
    depthMemo.set(nodeId, value)
    return value
  }
  if (entry !== undefined && depth(entry.id) > budget.maxDepth) diagnostic(diagnostics, 'WORKFLOW_DEPTH_EXCEEDED', 'policy.budget.maxDepth', `Workflow depth exceeds ${budget.maxDepth}`)
}

function validatePolicyLimits(definition: WorkflowDraft | WorkflowDefinition, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): void {
  const budget = definition.policy.budget
  let totalTokens = 0
  let totalMessages = 0
  let totalCost = 0
  for (const [index, node] of definition.nodes.entries()) {
    const path = `nodes[${index}]`
    totalTokens += node.tokenBudget ?? 0
    totalMessages += node.messageBudget ?? 0
    totalCost += node.costUnits ?? 0
    if ((node.maxConcurrency ?? 1) > budget.maxParallel) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', `${path}.maxConcurrency`, 'Node concurrency exceeds policy maxParallel')
    if (node.map?.maxFanOut !== undefined && node.map.maxFanOut > budget.maxFanOut) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', `${path}.map.maxFanOut`, 'Map fan-out exceeds policy maxFanOut')
    if (definition.policy.allowedCapabilities !== undefined && node.capability !== undefined && !definition.policy.allowedCapabilities.includes(node.capability)) {
      diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', `${path}.capability`, `Capability is not allowed by policy: ${node.capability}`)
    }
    if (definition.policy.allowedPermissions !== undefined) {
      for (const permission of node.permissions ?? []) if (!definition.policy.allowedPermissions.includes(permission)) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', `${path}.permissions`, `Permission is not allowed by policy: ${permission}`)
    }
    if (node.effect !== undefined && node.effect.kind !== 'none' && definition.policy.allowExternalEffects !== true) {
      diagnostic(diagnostics, 'WORKFLOW_EXTERNAL_EFFECT_UNDECLARED', `${path}.effect`, 'External effects are disabled by default and require policy allowExternalEffects=true')
    }
  }
  if (totalTokens > budget.maxTokens) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', 'policy.budget.maxTokens', 'Sum of node token budgets exceeds policy maxTokens')
  if (totalMessages > budget.maxMessages) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', 'policy.budget.maxMessages', 'Sum of node message budgets exceeds policy maxMessages')
  if (totalCost > budget.maxCostUnits) diagnostic(diagnostics, 'WORKFLOW_POLICY_VIOLATION', 'policy.budget.maxCostUnits', 'Sum of node cost units exceeds policy maxCostUnits')
}

function validateCommon(definition: WorkflowDraft | WorkflowDefinition, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): void {
  if (definition.nodes.length === 0) diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', 'nodes', 'Workflow must contain at least one node')
  const ids = new Set<string>()
  for (const node of definition.nodes) {
    if (ids.has(node.id)) diagnostic(diagnostics, 'WORKFLOW_DUPLICATE_ID', `nodes.${node.id}`, 'Duplicate node id')
    ids.add(node.id)
  }
  if (definition.policy.budget.maxDepth > MAX_DEPTH) diagnostic(diagnostics, 'WORKFLOW_LIMIT_EXCEEDED', 'policy.budget.maxDepth', `maxDepth cannot exceed ${MAX_DEPTH}`)
  validateReferencesAndGraph(definition, diagnostics)
  validatePolicyLimits(definition, diagnostics)
}

function scanInputSafety(input: unknown, diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[]): void {
  try {
    assertNoCredentialMaterial(input, 'Workflow definition contains credential material')
  } catch {
    diagnostic(diagnostics, 'WORKFLOW_CREDENTIAL_MATERIAL', '', 'Workflow definitions must not contain API keys, tokens, secrets, or credential-bearing URLs')
  }
  try {
    JSON.stringify(input)
  } catch {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', '', 'Workflow definition must be JSON serializable')
  }
}

export function validateWorkflowDraft(input: unknown): WorkflowDraftValidationResult {
  const diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[] = []
  scanInputSafety(input, diagnostics)
  if (!isRecord(input)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', '', 'Workflow draft must be a JSON object')
    return { ok: false, diagnostics }
  }
  const draft = workflowBase(input, diagnostics, false) as WorkflowDraft | undefined
  if (draft !== undefined) validateCommon(draft, diagnostics)
  return diagnostics.length === 0 && draft !== undefined
    ? { ok: true, diagnostics, draft: clone(draft) }
    : { ok: false, diagnostics }
}

export function validateWorkflow(input: unknown): WorkflowValidationResult {
  const diagnostics: import('./fleet-v2-types.js').WorkflowDiagnostic[] = []
  scanInputSafety(input, diagnostics)
  if (!isRecord(input)) {
    diagnostic(diagnostics, 'WORKFLOW_INVALID_SHAPE', '', 'Workflow definition must be a JSON object')
    return { ok: false, diagnostics }
  }
  const definition = workflowBase(input, diagnostics, true) as WorkflowDefinition | undefined
  if (definition !== undefined) validateCommon(definition, diagnostics)
  return diagnostics.length === 0 && definition !== undefined
    ? { ok: true, diagnostics, definition: clone(definition) }
    : { ok: false, diagnostics }
}

export function assertValidWorkflowDraft(input: unknown): WorkflowDraft {
  const result = validateWorkflowDraft(input)
  if (!result.ok || result.draft === undefined) {
    const first = result.diagnostics[0]
    throw new WorkflowValidationError(first?.code ?? 'WORKFLOW_INVALID_SHAPE', first?.message ?? 'Invalid Workflow draft', result.diagnostics)
  }
  return result.draft
}

export function assertValidWorkflow(input: unknown): WorkflowDefinition {
  const result = validateWorkflow(input)
  if (!result.ok || result.definition === undefined) {
    const first = result.diagnostics[0]
    throw new WorkflowValidationError(first?.code ?? 'WORKFLOW_INVALID_SHAPE', first?.message ?? 'Invalid Workflow definition', result.diagnostics)
  }
  return result.definition
}

/**
 * Schema migration seam. Version 1 is already canonical; future versions can
 * be upgraded here without teaching the Store or Gateway about old shapes.
 */
export function migrateWorkflowManifest(input: unknown): WorkflowDefinition {
  return assertValidWorkflow(input)
}

export function workflowDiagnosticSummary(result: WorkflowValidationResult | WorkflowDraftValidationResult): string {
  return result.diagnostics.map(item => `${item.code} at ${item.path || '<root>'}: ${item.message}`).join('; ')
}
