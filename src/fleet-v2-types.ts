/**
 * Product-layer contracts for Fleet v2.
 *
 * These types deliberately do not import Gateway, Mailbox, Agent, or ACL
 * implementation details. They are serializable descriptions that the
 * control-plane integration can validate before it decides whether and how
 * to execute them.
 */

export const FLEET_V2_SCHEMA_VERSION = 1 as const
export type FleetV2SchemaVersion = typeof FLEET_V2_SCHEMA_VERSION

export type WorkflowScope = 'user' | 'workspace' | 'shared'
export type WorkflowStatus = 'active' | 'deleted'

export type WorkflowNodeKind =
  | 'task'
  | 'sequential'
  | 'parallel'
  | 'condition'
  | 'map'
  | 'reduce'
  | 'approval'
  | 'retry'
  | 'timeout'
  | 'compensation'

export type WorkflowScalar = string | number | boolean | null

export type WorkflowValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown'

export type WorkflowReference =
  | {
      readonly kind: 'input'
      readonly name: string
    }
  | {
      readonly kind: 'node-output'
      readonly nodeId: string
      readonly output: string
    }
  | {
      readonly kind: 'constant'
      readonly value: WorkflowScalar
    }

export interface WorkflowInputDefinition {
  readonly name: string
  readonly type: WorkflowValueType
  readonly required?: boolean
  readonly description?: string
}

export interface WorkflowInputBinding {
  readonly name: string
  readonly source: WorkflowReference
}

export interface WorkflowOutputDefinition {
  readonly name: string
  readonly source: WorkflowReference
  readonly description?: string
}

export interface WorkflowEdge {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export type WorkflowEffectKind =
  | 'none'
  | 'task-dispatch'
  | 'message-send'
  | 'file-write'
  | 'network-request'

/**
 * External effects are declarations only. The product layer never executes
 * them; the control plane must independently authorize them at runtime.
 */
export interface WorkflowEffectDeclaration {
  readonly kind: WorkflowEffectKind
  readonly declaration?: string
  readonly targetCapability?: string
}

export interface WorkflowCondition {
  readonly source: WorkflowReference
  readonly operator: 'equals' | 'not-equals' | 'exists' | 'truthy' | 'contains'
  readonly value?: WorkflowScalar
  readonly whenTrue: string
  readonly whenFalse?: string
}

export interface WorkflowMapSpec {
  readonly source: WorkflowReference
  readonly itemInput: string
  readonly templateNodeId: string
  readonly maxFanOut?: number
}

export interface WorkflowReduceSpec {
  readonly source: WorkflowReference
  readonly reducer: 'concat' | 'first-success' | 'all-success' | 'count'
  readonly outputName?: string
}

export interface WorkflowApprovalSpec {
  readonly risk: 'low' | 'medium' | 'high'
  readonly requestedBy: 'requester' | 'operator' | 'policy'
  readonly reason: string
}

export interface WorkflowRetrySpec {
  readonly maxAttempts: number
  readonly backoffMs?: number
}

export interface WorkflowTimeoutSpec {
  readonly timeoutMs: number
}

export interface WorkflowCompensationSpec {
  readonly nodeId: string
  readonly on: 'failure' | 'cancel' | 'timeout'
}

export interface WorkflowNode {
  readonly id: string
  readonly label: string
  readonly kind: WorkflowNodeKind
  readonly dependsOn?: readonly string[]
  readonly children?: readonly string[]
  readonly inputs?: readonly WorkflowInputBinding[]
  readonly outputs?: readonly string[]
  readonly capability?: string
  readonly permissions?: readonly string[]
  readonly effect?: WorkflowEffectDeclaration
  readonly costUnits?: number
  readonly tokenBudget?: number
  readonly messageBudget?: number
  readonly maxConcurrency?: number
  readonly condition?: WorkflowCondition
  readonly map?: WorkflowMapSpec
  readonly reduce?: WorkflowReduceSpec
  readonly approval?: WorkflowApprovalSpec
  readonly retry?: WorkflowRetrySpec
  readonly timeout?: WorkflowTimeoutSpec
  readonly compensation?: WorkflowCompensationSpec
}

export interface WorkflowBudget {
  readonly maxDepth: number
  readonly maxParallel: number
  readonly maxFanOut: number
  readonly maxMessages: number
  readonly maxTokens: number
  readonly maxCostUnits: number
}

export interface WorkflowPolicy {
  readonly budget: WorkflowBudget
  readonly allowedCapabilities?: readonly string[]
  readonly allowedPermissions?: readonly string[]
  readonly allowExternalEffects?: boolean
  readonly approvalRequiredFor?: readonly ('external-effect' | 'high-risk' | 'high-cost')[]
}

export interface WorkflowDraft {
  readonly name: string
  readonly description?: string
  readonly ownerId: string
  readonly scope: WorkflowScope
  readonly workspaceId?: string
  readonly tags?: readonly string[]
  readonly entryNodeId: string
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
  readonly inputs: readonly WorkflowInputDefinition[]
  readonly outputs: readonly WorkflowOutputDefinition[]
  readonly policy: WorkflowPolicy
}

export interface WorkflowDefinition extends WorkflowDraft {
  readonly schemaVersion: FleetV2SchemaVersion
  readonly id: string
  readonly revision: number
  readonly status: WorkflowStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorkflowManifest {
  readonly manifestVersion: FleetV2SchemaVersion
  readonly exportedAt: number
  readonly workflow: WorkflowDefinition
  readonly sha256: string
}

export type WorkflowValidationErrorCode =
  | 'WORKFLOW_INVALID_SHAPE'
  | 'WORKFLOW_UNSUPPORTED_SCHEMA'
  | 'WORKFLOW_INVALID_ID'
  | 'WORKFLOW_DUPLICATE_ID'
  | 'WORKFLOW_DUPLICATE_NAME'
  | 'WORKFLOW_UNKNOWN_NODE'
  | 'WORKFLOW_UNKNOWN_REFERENCE'
  | 'WORKFLOW_CYCLE'
  | 'WORKFLOW_ORPHAN_NODE'
  | 'WORKFLOW_DEPTH_EXCEEDED'
  | 'WORKFLOW_LIMIT_EXCEEDED'
  | 'WORKFLOW_UNSAFE_INPUT'
  | 'WORKFLOW_CREDENTIAL_MATERIAL'
  | 'WORKFLOW_EXTERNAL_EFFECT_UNDECLARED'
  | 'WORKFLOW_POLICY_VIOLATION'

export interface WorkflowDiagnostic {
  readonly code: WorkflowValidationErrorCode
  readonly path: string
  readonly message: string
}

export interface WorkflowValidationResult {
  readonly ok: boolean
  readonly diagnostics: readonly WorkflowDiagnostic[]
  readonly definition?: WorkflowDefinition
}

export type ManagerPolicyDecision = 'allow' | 'approval-required' | 'deny' | 'replan-required'
export type ManagerBotStatus = 'available' | 'busy' | 'unavailable' | 'timeout' | 'failed' | 'low-confidence'

export interface ManagerBotDescriptor {
  readonly id: string
  readonly title?: string
  readonly capabilities: readonly string[]
  readonly skills?: readonly string[]
  readonly role?: 'worker' | 'verifier' | 'synthesizer' | 'generalist' | 'manager'
  readonly enabled: boolean
  /** The Gateway/ACL layer supplies this fact; policy never derives or mutates it. */
  readonly authorized: boolean
  readonly status?: ManagerBotStatus
  readonly confidence?: number
  readonly inFlight?: number
  readonly costPerRun?: number
}

export interface ManagerBudget {
  readonly maxBots: number
  readonly maxParallelRuns: number
  readonly maxDepth: number
  readonly maxMessages: number
  readonly maxTokens: number
  readonly maxCostUnits: number
  readonly maxFanOut: number
  readonly maxHops: number
}

export interface ManagerTaskInput {
  readonly taskId: string
  readonly traceId: string
  readonly requester: string
  readonly instruction: string
  readonly requiredCapabilities?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
  readonly risk?: 'low' | 'medium' | 'high'
  readonly requiresExternalEffect?: boolean
  readonly budget?: Partial<ManagerBudget>
  readonly maxAssignments?: number
}

export interface DelegationBudgetSlice {
  readonly maxTokens: number
  readonly maxCostUnits: number
  readonly maxMessages: number
  readonly maxDepth: number
}

export interface DelegationIntent {
  readonly intentId: string
  readonly taskId: string
  readonly traceId: string
  readonly fromManager: string
  readonly toBot: string
  readonly instruction: string
  readonly acceptanceCriteria: readonly string[]
  readonly reason: readonly string[]
  readonly budget: DelegationBudgetSlice
  readonly requiresApproval: boolean
  readonly hop: number
  readonly visitedBotIds: readonly string[]
}

export interface ApprovalRequirement {
  readonly required: boolean
  readonly risk: 'low' | 'medium' | 'high'
  readonly reason: readonly string[]
  readonly scope: 'delegation' | 'external-effect' | 'workflow'
}

export interface ManagerPlan {
  readonly schemaVersion: FleetV2SchemaVersion
  readonly planId: string
  readonly planRevision: number
  readonly taskId: string
  readonly traceId: string
  readonly policyDecision: ManagerPolicyDecision
  readonly reasons: readonly string[]
  readonly budget: ManagerBudget
  readonly delegations: readonly DelegationIntent[]
  readonly approval: ApprovalRequirement
  readonly generatedAt: number
}

export interface ManagerReplanObservation {
  readonly botId: string
  readonly status: Exclude<ManagerBotStatus, 'available' | 'busy'>
  readonly reason?: string
  readonly confidence?: number
}

export interface ManagerReplanInput {
  readonly task: ManagerTaskInput
  readonly currentPlan: ManagerPlan
  readonly observations: readonly ManagerReplanObservation[]
  readonly availableBots: readonly ManagerBotDescriptor[]
  readonly managerBotId: string
  readonly planRevision?: number
}

export interface ReplanSuggestion {
  readonly schemaVersion: FleetV2SchemaVersion
  readonly planId: string
  readonly planRevision: number
  readonly taskId: string
  readonly traceId: string
  readonly policyDecision: ManagerPolicyDecision
  readonly reasons: readonly string[]
  readonly replacementDelegations: readonly DelegationIntent[]
  readonly approval: ApprovalRequirement
}

export type MentionTargetKind = 'bot' | 'team' | 'manager'

export interface MentionTarget {
  readonly kind: MentionTargetKind
  readonly id: string
  readonly normalized: string
  readonly raw: string
  readonly start: number
  readonly end: number
  readonly known: boolean
  readonly self: boolean
}

export interface MentionParserOptions {
  readonly knownBots?: readonly string[]
  readonly knownTeams?: readonly string[]
  readonly managerIds?: readonly string[]
  readonly selfId?: string
  readonly maxTargets?: number
  readonly maxInputLength?: number
  readonly hop?: number
  readonly maxHop?: number
  readonly visited?: readonly string[]
  readonly mentionBudget?: number
}

export interface MentionParseMetadata {
  readonly hop: number
  readonly visited: readonly string[]
  readonly mentionBudget: number
  readonly remainingMentionBudget: number
  readonly truncated: boolean
  readonly diagnostic?: string
}

export interface MentionParseResult {
  readonly rawText: string
  readonly instruction: string
  readonly targets: readonly MentionTarget[]
  readonly routableTargets: readonly MentionTarget[]
  readonly unknownTargets: readonly MentionTarget[]
  readonly metadata: MentionParseMetadata
}
