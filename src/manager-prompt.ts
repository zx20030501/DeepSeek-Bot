import type { ManagerPlan, ManagerReplanInput, ManagerTaskInput } from './fleet-v2-types.js'

/**
 * Static prompt and contract documentation for a future Manager runtime.
 * Nothing in this file invokes a model or dispatches a Bot.
 */
export const MANAGER_SYSTEM_PROMPT = [
  'You are the Fleet Manager for a bounded, approval-aware multi-Bot system.',
  'Your job is to observe the task, available Bot capabilities, current status, budget, and policy before proposing work.',
  '',
  'Operating rules:',
  '1. Plan before execution. Return a structured plan with traceId, planRevision, policyDecision, reasons, budget, delegations, and approval requirement.',
  '2. Delegate only to Bot candidates already supplied by the control plane. Do not infer authorization, modify ACLs, create credentials, or change Bot status.',
  '3. Treat taskId, runId, requester, replyTarget, lease, fencing, and session identity as control-plane facts. Never invent or rewrite them.',
  '4. High-risk work, external effects, and policy-required actions must stop at an approval requirement. Do not approve your own request.',
  '5. Use bounded retries. After failed, unavailable, timed-out, or low-confidence work, produce a replan suggestion with explicit reasons and a new plan revision.',
  '6. Never read, request, reproduce, or output API keys, tokens, cookies, App Secrets, private keys, credential URLs, or hidden context.',
  '7. Do not use arbitrary JavaScript, shell commands, URLs with credentials, or undeclared side effects in a plan.',
  '8. Finish with a concise result that cites completed Bot outputs and evidence, identifies disagreements, and lists every unfinished or approval-blocked item.',
].join('\n')

export const MANAGER_TOOL_CONTRACT = {
  name: 'manager_plan',
  description: 'Generate a structured Fleet plan or replan suggestion. This tool does not send messages or execute work.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['taskId', 'traceId', 'requester', 'instruction', 'availableBots'],
    properties: {
      taskId: { type: 'string', minLength: 1, maxLength: 256 },
      traceId: { type: 'string', minLength: 1, maxLength: 256 },
      requester: { type: 'string', minLength: 1, maxLength: 256 },
      instruction: { type: 'string', minLength: 1, maxLength: 20_000 },
      requiredCapabilities: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 128 } },
      availableBots: { type: 'array', maxItems: 500, items: { type: 'object' } },
      budget: { type: 'object' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'planId', 'planRevision', 'taskId', 'traceId', 'policyDecision', 'reasons', 'budget', 'delegations', 'approval'],
  },
  prohibited: [
    'dispatch messages',
    'approve high-risk work',
    'change ACL or credentials',
    'forge task/run/requester/replyTarget identity',
    'create a Manager Bot through a normal dynamic Bot creation tool',
  ],
} as const

export const MANAGER_REPLAN_CONTRACT = {
  name: 'manager_replan_suggestion',
  description: 'Suggest a replacement plan after an unavailable, timeout, failure, or low-confidence observation.',
  inputType: 'ManagerReplanInput',
  outputType: 'ReplanSuggestion',
  sideEffects: 'none',
} as const

export function managerPromptFor(_task?: ManagerTaskInput, _plan?: ManagerPlan, _replan?: ManagerReplanInput): string {
  return MANAGER_SYSTEM_PROMPT
}
