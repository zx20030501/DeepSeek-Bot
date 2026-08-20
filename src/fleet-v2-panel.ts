// React is published as a CommonJS `export =` package in this repository.
// The existing client bundle resolves named React imports at build time, while
// the server-side TypeScript check intentionally does not enable esModuleInterop.
// Keep this isolated component compatible with both paths.
// @ts-expect-error The client bundler supplies React's named createElement export.
import { createElement as reactCreateElement } from 'react'
import type { ManagerPlan, WorkflowDefinition } from './fleet-v2-types.js'

type PanelNode = unknown
type PanelElement = { readonly type: unknown; readonly props: unknown }
const createElement = reactCreateElement as unknown as (type: unknown, props: unknown, ...children: readonly unknown[]) => PanelElement

export interface FleetV2TeamSummary {
  readonly id: string
  readonly name: string
  readonly managerBotId?: string
  readonly memberBotIds: readonly string[]
  readonly status: string
  readonly maxConcurrency: number
}

export interface FleetV2ThreadSummary {
  readonly id: string
  readonly teamId: string
  readonly participantBotIds: readonly string[]
  readonly status: string
  readonly taskId?: string
  readonly updatedAt: number
}

export interface FleetV2BotSummary {
  readonly id: string
  readonly title: string
  readonly capabilities: readonly string[]
  readonly status: string
  readonly inFlight?: number
}

export interface FleetV2AuditSummary {
  readonly id: string
  readonly at: number
  readonly action: string
  readonly entityId: string
  readonly actor: string
}

export interface FleetV2PanelProps {
  readonly workflows: readonly WorkflowDefinition[]
  readonly plans: readonly ManagerPlan[]
  readonly teams: readonly FleetV2TeamSummary[]
  readonly threads: readonly FleetV2ThreadSummary[]
  readonly bots: readonly FleetV2BotSummary[]
  readonly audit: readonly FleetV2AuditSummary[]
  readonly onSelectWorkflow?: (workflowId: string) => void
}

function text(value: PanelNode, key?: string): PanelElement {
  return createElement('span', { key }, value)
}

function list(items: readonly PanelNode[], className: string): PanelElement {
  return createElement('ul', { className }, items.map((item, index) => createElement('li', { key: index }, item)))
}

function panelSection(title: string, body: PanelNode, key: string): PanelElement {
  return createElement('section', { className: 'dsh-fleet-v2-panel__section', key }, [
    createElement('h3', { key: 'title' }, title),
    createElement('div', { key: 'body' }, body),
  ])
}

/**
 * Presentational Fleet v2 panel. It intentionally receives snapshots through
 * props and has no Gateway, transport, credential, or mutation dependency.
 */
export function FleetV2Panel(props: FleetV2PanelProps): PanelElement {
  const workflowItems = props.workflows.map(workflow => createElement('button', {
    key: workflow.id,
    type: 'button',
    className: 'dsh-fleet-v2-panel__row',
    onClick: props.onSelectWorkflow === undefined ? undefined : () => props.onSelectWorkflow?.(workflow.id),
  }, [
    text(`${workflow.name} · v${workflow.revision}`, 'name'),
    text(`${workflow.status} · ${workflow.nodes.length} nodes`, 'status'),
  ]))
  const planItems = props.plans.map(plan => createElement('li', { key: plan.planId }, [
    text(`${plan.policyDecision} · ${plan.planId}@${plan.planRevision}`, 'plan'),
    text(`${plan.delegations.length} delegations · approval ${plan.approval.required ? 'required' : 'not required'}`, 'approval'),
  ]))
  const teamItems = props.teams.map(team => createElement('li', { key: team.id }, [
    text(`${team.name} · ${team.status}`, 'name'),
    text(`${team.memberBotIds.length} members · concurrency ${team.maxConcurrency}${team.managerBotId === undefined ? '' : ` · manager @${team.managerBotId}`}`, 'meta'),
  ]))
  const threadItems = props.threads.map(thread => createElement('li', { key: thread.id }, [
    text(`${thread.id} · ${thread.status}`, 'name'),
    text(`${thread.participantBotIds.length} participants${thread.taskId === undefined ? '' : ` · task ${thread.taskId}`}`, 'meta'),
  ]))
  const botItems = props.bots.map(bot => createElement('li', { key: bot.id }, [
    text(`@${bot.id} · ${bot.title} · ${bot.status}`, 'name'),
    text(`${bot.capabilities.slice(0, 8).join(', ') || 'no declared capabilities'}${bot.inFlight === undefined ? '' : ` · in-flight ${bot.inFlight}`}`, 'meta'),
  ]))
  const auditItems = props.audit.slice(-20).reverse().map(record => createElement('li', { key: record.id }, [
    text(`${record.action} · ${record.entityId}`, 'action'),
    text(`${record.actor} · ${new Date(record.at).toISOString()}`, 'meta'),
  ]))
  return createElement('div', { className: 'dsh-fleet-v2-panel', 'data-testid': 'fleet-v2-panel' }, [
    createElement('header', { className: 'dsh-fleet-v2-panel__header', key: 'header' }, [
      createElement('h2', { key: 'title' }, 'Fleet v2'),
      createElement('p', { key: 'description' }, 'Workflow、Manager plan、Team/Thread、Bot capability 和审计摘要。'),
    ]),
    panelSection('Workflows', list(workflowItems, 'dsh-fleet-v2-panel__list'), 'workflows'),
    panelSection('Manager plans', list(planItems, 'dsh-fleet-v2-panel__list'), 'plans'),
    panelSection('Teams', list(teamItems, 'dsh-fleet-v2-panel__list'), 'teams'),
    panelSection('Agent threads', list(threadItems, 'dsh-fleet-v2-panel__list'), 'threads'),
    panelSection('Bot capabilities', list(botItems, 'dsh-fleet-v2-panel__list'), 'bots'),
    panelSection('Audit summary', list(auditItems, 'dsh-fleet-v2-panel__list'), 'audit'),
  ])
}
