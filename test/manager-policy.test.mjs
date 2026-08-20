import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MANAGER_BUDGET,
  generateManagerPlan,
  generateReplanSuggestion,
  managerPolicySummary,
} from '../dist/manager-policy.js'
import { MANAGER_SYSTEM_PROMPT, MANAGER_TOOL_CONTRACT } from '../dist/manager-prompt.js'

function bot(id, overrides = {}) {
  return {
    id,
    title: id,
    capabilities: [id],
    enabled: true,
    authorized: true,
    ...overrides,
  }
}

test('selects authorized candidates, respects budgets, and requires approval for high-risk work', () => {
  const plan = generateManagerPlan({
    taskId: 'task-1',
    traceId: 'trace-1',
    requester: 'user:a',
    instruction: 'research and review this topic',
    requiredCapabilities: ['research', 'review'],
    risk: 'high',
    budget: { maxBots: 2, maxParallelRuns: 2, maxFanOut: 2, maxMessages: 10, maxTokens: 20_000, maxCostUnits: 100 },
  }, 'manager', [
    bot('researcher', { capabilities: ['research'] }),
    bot('reviewer', { capabilities: ['review'], role: 'verifier' }),
    bot('denied', { capabilities: ['research'], authorized: false }),
    bot('manager-worker', { capabilities: ['research'], role: 'manager' }),
  ], { planRevision: 3, now: 100 })
  assert.equal(plan.policyDecision, 'approval-required')
  assert.equal(plan.planRevision, 3)
  assert.equal(plan.delegations.length, 2)
  assert.deepEqual(plan.delegations.map(item => item.toBot).sort(), ['researcher', 'reviewer'])
  assert.equal(plan.approval.required, true)
  assert.ok(plan.reasons.some(reason => reason.includes('authorization')))
  assert.match(managerPolicySummary(plan), /approval=required/u)
})

test('denies when required capabilities cannot be covered or all Bots are unavailable', () => {
  const plan = generateManagerPlan({
    taskId: 'task-2', traceId: 'trace-2', requester: 'user:a', instruction: 'specialized task', requiredCapabilities: ['missing'],
  }, 'manager', [bot('offline', { status: 'timeout' })])
  assert.equal(plan.policyDecision, 'deny')
  assert.equal(plan.delegations.length, 0)
  assert.ok(plan.reasons.some(reason => reason.includes('timeout')))
})

test('replans around failed and low-confidence Bots without dispatching anything', () => {
  const task = { taskId: 'task-3', traceId: 'trace-3', requester: 'user:a', instruction: 'research', requiredCapabilities: ['research'] }
  const initial = generateManagerPlan(task, 'manager', [bot('first', { capabilities: ['research'] })], { now: 100 })
  const suggestion = generateReplanSuggestion({
    task,
    currentPlan: initial,
    observations: [{ botId: 'first', status: 'failed', reason: 'provider timeout' }],
    availableBots: [bot('first', { capabilities: ['research'] }), bot('replacement', { capabilities: ['research'] })],
    managerBotId: 'manager',
  })
  assert.equal(suggestion.policyDecision, 'replan-required')
  assert.deepEqual(suggestion.replacementDelegations.map(item => item.toBot), ['replacement'])
  assert.ok(suggestion.reasons.some(reason => reason.includes('provider timeout')))
})

test('handles 500 logical Bots as pure policy data with bounded output', () => {
  const bots = Array.from({ length: 500 }, (_, index) => bot(`worker-${String(index).padStart(3, '0')}`, { capabilities: ['classification'] }))
  const plan = generateManagerPlan({
    taskId: 'task-scale', traceId: 'trace-scale', requester: 'user:a', instruction: 'classify records',
    budget: { maxBots: 100, maxParallelRuns: 100, maxFanOut: 100 },
  }, 'manager', bots)
  assert.equal(plan.policyDecision, 'allow')
  assert.equal(plan.delegations.length, 100)
  assert.ok(plan.delegations.every(item => item.budget.maxMessages <= DEFAULT_MANAGER_BUDGET.maxMessages))
})

test('rejects credential-bearing policy input and invalid budgets', () => {
  assert.throws(
    () => generateManagerPlan({ taskId: 'task-secret', traceId: 'trace-secret', requester: 'user:a', instruction: `https://example.test/?api_key=${'a'.repeat(24)}` }, 'manager', []),
    error => error?.code === 'MANAGER_CREDENTIAL_MATERIAL',
  )
  assert.throws(
    () => generateManagerPlan({ taskId: 'task-budget', traceId: 'trace-budget', requester: 'user:a', instruction: 'x', budget: { maxBots: 0 } }, 'manager', []),
    error => error?.code === 'MANAGER_BUDGET_INVALID',
  )
})

test('prompt and tool contract preserve the approval and identity boundaries', () => {
  assert.match(MANAGER_SYSTEM_PROMPT, /Plan before execution/u)
  assert.match(MANAGER_SYSTEM_PROMPT, /Never invent or rewrite/u)
  assert.match(MANAGER_SYSTEM_PROMPT, /API keys/u)
  assert.equal(MANAGER_TOOL_CONTRACT.name, 'manager_plan')
  assert.match(MANAGER_TOOL_CONTRACT.prohibited.join('|'), /dispatch messages/u)
})
