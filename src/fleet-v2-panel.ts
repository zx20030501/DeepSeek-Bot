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

/** JSON-text editor values for a saved Workflow; the caller owns serialization. */
export interface FleetV2WorkflowDraft {
  readonly name: string
  readonly description?: string
  readonly entryNodeId: string
  readonly nodesJson: string
  readonly edgesJson: string
  readonly policyJson: string
  readonly inputsJson: string
  readonly outputsJson: string
}

export interface FleetV2PanelProps {
  readonly workflows: readonly WorkflowDefinition[]
  readonly plans: readonly ManagerPlan[]
  readonly teams: readonly FleetV2TeamSummary[]
  readonly threads: readonly FleetV2ThreadSummary[]
  readonly bots: readonly FleetV2BotSummary[]
  readonly audit: readonly FleetV2AuditSummary[]
  readonly onSelectWorkflow?: (workflowId: string) => void
  readonly onCreateWorkflow?: (draft: FleetV2WorkflowDraft) => void
  readonly onUpdateWorkflow?: (workflowId: string, draft: FleetV2WorkflowDraft) => void
  readonly onSetWorkflowStatus?: (workflowId: string, status: 'active' | 'deleted') => void
  readonly onLaunchWorkflow?: (workflowId: string) => void
  readonly workflowEditorOpen?: boolean
  readonly workflowEditorWorkflowId?: string
  readonly workflowEditorDefault?: FleetV2WorkflowDraft
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

function draftToJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

/** Prefill the editor from an existing saved Workflow definition. */
export function workflowToDraft(workflow: WorkflowDefinition): FleetV2WorkflowDraft {
  return {
    name: workflow.name,
    ...(workflow.description === undefined ? {} : { description: workflow.description }),
    entryNodeId: workflow.entryNodeId,
    nodesJson: draftToJson(workflow.nodes),
    edgesJson: draftToJson(workflow.edges),
    policyJson: draftToJson(workflow.policy),
    inputsJson: draftToJson(workflow.inputs),
    outputsJson: draftToJson(workflow.outputs),
  }
}

/** Read the editor form's named fields into a draft. */
function collectWorkflowDraft(form: HTMLFormElement): FleetV2WorkflowDraft {
  const read = (name: string): string => {
    const control = form.elements.namedItem(name)
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) return control.value
    return ''
  }
  const description = read('wf-description').trim()
  return {
    name: read('wf-name').trim(),
    entryNodeId: read('wf-entry').trim(),
    ...(description === '' ? {} : { description }),
    nodesJson: read('wf-nodes'),
    edgesJson: read('wf-edges'),
    policyJson: read('wf-policy'),
    inputsJson: read('wf-inputs'),
    outputsJson: read('wf-outputs'),
  }
}

function editorField(label: string, hint: string, name: string, testId: string, defaultValue: string | undefined, multiline: boolean): PanelElement {
  const control = multiline
    ? createElement('textarea', { name, 'data-testid': testId, defaultValue: defaultValue ?? '', rows: 4 })
    : createElement('input', { name, 'data-testid': testId, defaultValue: defaultValue ?? '' })
  return createElement('label', { className: 'dsh-fleet-v2-panel__field', key: name }, [
    createElement('span', { key: 'label' }, label),
    createElement('small', { key: 'hint' }, hint),
    control,
  ])
}

function WorkflowManagerSection(props: {
  readonly workflows: readonly WorkflowDefinition[]
  readonly editorOpen: boolean
  readonly editorWorkflowId?: string
  readonly editorDefault?: FleetV2WorkflowDraft
  readonly onSelectWorkflow?: (workflowId: string) => void
  readonly onCreateWorkflow?: (draft: FleetV2WorkflowDraft) => void
  readonly onUpdateWorkflow?: (workflowId: string, draft: FleetV2WorkflowDraft) => void
  readonly onSetWorkflowStatus?: (workflowId: string, status: 'active' | 'deleted') => void
  readonly onLaunchWorkflow?: (workflowId: string) => void
}): PanelElement {
  const rows = props.workflows.map(workflow => createElement('div', {
    className: 'dsh-fleet-v2-panel__wf-row',
    key: workflow.id,
    'data-testid': `wf-row-${workflow.id}`,
  }, [
    createElement('div', { className: 'dsh-fleet-v2-panel__wf-meta', key: 'meta' }, [
      text(workflow.name, 'name'),
      text(`${workflow.status} · v${workflow.revision} · ${workflow.nodes.length} nodes · ${workflow.scope}`, 'status'),
      text(workflow.id, 'id'),
    ]),
    createElement('div', { className: 'dsh-fleet-v2-panel__wf-actions', key: 'actions' }, [
      createElement('button', {
        type: 'button',
        'data-testid': `wf-launch-${workflow.id}`,
        onClick: props.onLaunchWorkflow === undefined ? undefined : () => props.onLaunchWorkflow?.(workflow.id),
      }, '启动'),
      createElement('button', {
        type: 'button',
        'data-testid': `wf-status-${workflow.id}`,
        onClick: props.onSetWorkflowStatus === undefined ? undefined : () => props.onSetWorkflowStatus?.(workflow.id, workflow.status === 'active' ? 'deleted' : 'active'),
      }, workflow.status === 'active' ? '停用' : '启用'),
      createElement('button', {
        type: 'button',
        'data-testid': `wf-edit-${workflow.id}`,
        onClick: props.onSelectWorkflow === undefined ? undefined : () => props.onSelectWorkflow?.(workflow.id),
      }, '编辑'),
    ]),
  ]))
  const editor = props.editorOpen ? createElement('form', {
    className: 'dsh-fleet-v2-panel__wf-editor',
    'data-testid': 'wf-editor',
    key: 'editor',
    onSubmit: (event: { preventDefault: () => void }) => event.preventDefault(),
  }, [
    editorField('名称', 'Workflow 名称', 'wf-name', 'wf-name', props.editorDefault?.name, false),
    editorField('入口节点', 'entryNodeId（必须指向一个任务节点）', 'wf-entry', 'wf-entry', props.editorDefault?.entryNodeId, false),
    editorField('描述', '可选', 'wf-description', 'wf-description', props.editorDefault?.description, false),
    editorField('节点 JSON', 'nodes: [{id,label,kind,capability,outputs,...}]', 'wf-nodes', 'wf-nodes', props.editorDefault?.nodesJson, true),
    editorField('边 JSON', 'edges: [{from,to}]', 'wf-edges', 'wf-edges', props.editorDefault?.edgesJson, true),
    editorField('输入 JSON', 'inputs: [{name,type,required}]', 'wf-inputs', 'wf-inputs', props.editorDefault?.inputsJson, true),
    editorField('输出 JSON', 'outputs: [{name,source}]', 'wf-outputs', 'wf-outputs', props.editorDefault?.outputsJson, true),
    editorField('策略 JSON', 'policy: {budget,allowedCapabilities,...}', 'wf-policy', 'wf-policy', props.editorDefault?.policyJson, true),
    createElement('div', { className: 'dsh-fleet-v2-panel__actions', key: 'actions' }, [
      createElement('button', {
        type: 'submit',
        'data-testid': 'wf-save',
        onClick: (event: unknown) => {
          const current = event as { currentTarget: HTMLElement }
          const form = current.currentTarget.closest('form')
          if (form === null) return
          const draft = collectWorkflowDraft(form)
          if (props.editorWorkflowId === undefined) props.onCreateWorkflow?.(draft)
          else props.onUpdateWorkflow?.(props.editorWorkflowId, draft)
        },
      }, props.editorWorkflowId === undefined ? '创建' : '保存修改'),
      createElement('button', {
        type: 'button',
        'data-testid': 'wf-cancel',
        onClick: props.onSelectWorkflow === undefined ? undefined : () => props.onSelectWorkflow?.(''),
      }, '取消'),
    ]),
  ]) : undefined
  return createElement('section', { className: 'dsh-fleet-v2-panel__section', key: 'workflow-manager' }, [
    createElement('div', { className: 'dsh-fleet-v2-panel__wf-header', key: 'header' }, [
      createElement('h3', { key: 'title' }, 'Workflow 管理'),
      createElement('button', {
        type: 'button',
        'data-testid': 'wf-new',
        onClick: props.onSelectWorkflow === undefined ? undefined : () => props.onSelectWorkflow?.(''),
      }, '新建'),
    ]),
    createElement('div', { className: 'dsh-fleet-v2-panel__wf-list', key: 'list' }, [
      ...rows,
      ...(editor === undefined ? [] : [editor]),
    ]),
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
    WorkflowManagerSection({
      workflows: props.workflows,
      editorOpen: props.workflowEditorOpen === true,
      ...(props.workflowEditorWorkflowId === undefined ? {} : { editorWorkflowId: props.workflowEditorWorkflowId }),
      ...(props.workflowEditorDefault === undefined ? {} : { editorDefault: props.workflowEditorDefault }),
      ...(props.onSelectWorkflow === undefined ? {} : { onSelectWorkflow: props.onSelectWorkflow }),
      ...(props.onCreateWorkflow === undefined ? {} : { onCreateWorkflow: props.onCreateWorkflow }),
      ...(props.onUpdateWorkflow === undefined ? {} : { onUpdateWorkflow: props.onUpdateWorkflow }),
      ...(props.onSetWorkflowStatus === undefined ? {} : { onSetWorkflowStatus: props.onSetWorkflowStatus }),
      ...(props.onLaunchWorkflow === undefined ? {} : { onLaunchWorkflow: props.onLaunchWorkflow }),
    }),
    panelSection('Manager plans', list(planItems, 'dsh-fleet-v2-panel__list'), 'plans'),
    panelSection('Teams', list(teamItems, 'dsh-fleet-v2-panel__list'), 'teams'),
    panelSection('Agent threads', list(threadItems, 'dsh-fleet-v2-panel__list'), 'threads'),
    panelSection('Bot capabilities', list(botItems, 'dsh-fleet-v2-panel__list'), 'bots'),
    panelSection('Audit summary', list(auditItems, 'dsh-fleet-v2-panel__list'), 'audit'),
  ])
}
