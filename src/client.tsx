import {
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { HERMES_BOT_SETUP_ROUTE } from './setup-constants.js'

const SECRET_REF = 'DSH_HERMES_BOT_FEISHU_APP_SECRET'

interface HermesBotSettings {
  enabled: boolean
  feishu: {
    enabled: boolean
    appId: string
    domain: 'feishu' | 'lark'
    requireMention: boolean
  }
  access: {
    userIds: string[]
    chatIds: string[]
    pairing: boolean
  }
  collaboration: FleetSettings
  profiles: FleetProfileSettings[]
}

interface FleetSettings {
  enabled: boolean
  autoPlanner: boolean
  approvalMode: 'never' | 'auto-planned' | 'multi-bot' | 'always'
  defaultSessionScope: 'requester' | 'chat' | 'shared' | 'task'
  maxGroupBots: number
  maxGroupRounds: number
  maxGroupMessages: number
  maxParallelRuns: number
  botRunMaxAttempts: number
  features: {
    dynamicRegistry: boolean
    chatBotCreation: boolean
    peerMessaging: boolean
    managerAgent: boolean
    savedWorkflows: boolean
    externalRuntimes: boolean
  }
}

interface FleetProfileBase {
  id: string
  title: string
  description: string
  provider: string
  model: string
  soul: string
  fleetRole: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  sessionScope: 'requester' | 'chat' | 'shared' | 'task'
  approvalRequired: boolean
  enabled: boolean
}

interface FleetProfileSettings extends FleetProfileBase {
  capabilities: string[]
  skills: string[]
  allowedUserIds: string[]
  allowedChatIds: string[]
}

interface FleetProfileDraft extends FleetProfileBase {
  capabilitiesText: string
  skillsText: string
  allowedUserIdsText: string
  allowedChatIdsText: string
}

interface CredentialState {
  configured: boolean
  writable: boolean
  source?: string
}

interface DiagnosticEvent {
  receivedAt?: number
  messageId?: string
  userId?: string
  chatId?: string
  chatType?: string
  mentionedBot?: boolean
  textLength?: number
  resourceCount?: number
  normalized?: boolean
  reason?: string
}

interface DiagnosticDecision {
  receivedAt?: number
  platform?: string
  messageId?: string
  userId?: string
  chatId?: string
  chatType?: string
  textLength?: number
  decision?: string
  reason?: string
}

interface PairingCandidate {
  receivedAt?: number
  userId?: string
  chatId?: string
  chatType?: string
}

interface AuthorizedUserRow {
  userId: string
  platform: string
  allowlisted: boolean
  paired: boolean
}

interface Diagnostics {
  enabled?: boolean
  accessMode?: string
  pairing?: {
    enabled?: boolean
    pending?: Array<{ code?: string; userId?: string; chatId?: string; expiresAt?: number }>
    approved?: Array<{ platform?: string; userId?: string; approvedAt?: number }>
  }
  discovery?: {
    active?: boolean
    command?: string
    expiresAt?: number
    candidate?: {
      receivedAt?: number
      userId?: string
      chatId?: string
      chatType?: string
    }
  }
  transports?: Record<string, {
    running?: boolean
    connected?: boolean
    inbound?: {
      received?: number
      last?: DiagnosticEvent | null
    }
    lastError?: string
  }>
  inbound?: {
    received?: number
    accepted?: number
    unauthorized?: number
    duplicate?: number
    last?: DiagnosticDecision | null
  }
  bots?: Array<{
    id?: string
    title?: string
    capabilities?: string[]
    skills?: string[]
    fleetRole?: string
    sessionScope?: string
    approvalRequired?: boolean
  }>
  collaboration?: { enabled?: boolean; activeRuns?: number }
  fleet?: {
    mailbox?: Record<string, number>
    tasks?: Array<{ id?: string; title?: string; status?: string; assignedTo?: string; updatedAt?: number }>
    workflows?: Array<{ id?: string; taskId?: string; status?: string; workerBotIds?: string[]; verifierBotId?: string; synthesizerBotId?: string; updatedAt?: number }>
    approvals?: Array<{ id?: string; code?: string; kind?: string; summary?: string; status?: string; expiresAt?: number }>
    handoffs?: Array<{ id?: string; fromBot?: string; toBot?: string; status?: string; reason?: string }>
    deadLetters?: Array<{ id?: string; state?: string; lastError?: string; envelope?: { to?: string; taskId?: string } }>
    registryBots?: Array<{
      id?: string
      handle?: string
      title?: string
      status?: string
      scope?: string
      source?: string
      version?: number
      revision?: number
      fleetRole?: string
      capabilities?: string[]
      runtimeReady?: boolean
      fleetMembership?: 'joined' | 'blocked' | 'not-joined'
      runtimeSource?: string
      runtimeDefinitionId?: string
      runtimeRevision?: number
      blockedReason?: string
      membershipReason?: string
      busy?: boolean
      activeRuns?: number
      lastFailure?: { runId?: string; taskId?: string; error?: string; at?: number }
      activationCode?: string
      updatedAt?: number
    }>
  }
}

interface FleetTaskDetailView {
  readonly task: {
    id: string
    title: string
    instruction: string
    status: string
    assignedTo: string
    result?: string
    error?: string
    createdAt: number
    updatedAt: number
  }
  readonly workflow?: {
    id: string
    status: string
    outputs?: Array<{ runId?: string; botId?: string; phase?: string; text?: string; at?: number }>
  }
  readonly runs: Array<{ id: string; botId: string; attempt: number; phase?: string; status: string; output?: string; error?: string; updatedAt: number }>
  readonly handoffs: Array<{ id: string; fromBot: string; toBot: string; reason: string; status: string }>
  readonly audits: Array<{ id: string; at: number; actor: string; action: string }>
  readonly deliveries: Array<{ id: string; state: string; attempts: number; botId: string; runId: string; lastError?: string }>
}

interface SetupState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly settings?: HermesBotSettings
  readonly writable: boolean
  readonly credential: CredentialState
  readonly diagnostics: Diagnostics
  readonly saving: boolean
  readonly diagnosing: boolean
  readonly pairingApproving: boolean
  readonly fleetApproving: boolean
  readonly fleetTaskAction?: string | undefined
  readonly botRegistryAction?: string | undefined
  readonly fleetTaskDetail?: FleetTaskDetailView | undefined
  readonly message?: string | undefined
  readonly error?: string | undefined
  readonly diagnosticsError?: string | undefined
}

interface Draft {
  enabled: boolean
  feishuEnabled: boolean
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  requireMention: boolean
  userIds: string[]
  chatIds: string[]
  pairingEnabled: boolean
  collaboration: FleetSettings
  profiles: FleetProfileDraft[]
}

function emptyCredential(): CredentialState {
  return { configured: false, writable: false }
}

function emptyDiagnostics(): Diagnostics {
  return {}
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(/[\s,，、;；\r\n]+/u).map(item => item.trim()).filter(Boolean))]
}

function normalizedRows(values: readonly string[]): string[] {
  return splitIds(values.join('\n'))
}

function appendUniqueRow(values: readonly string[], value: string): string[] {
  const additions = splitIds(value)
  if (additions.length === 0) return [...values]
  const existing = normalizedRows(values)
  return [...values, ...additions.filter(item => !existing.includes(item))]
}

function updateRowValue(values: readonly string[], index: number, value: string): string[] {
  const next = [...values]
  const pieces = splitIds(value)
  if (pieces.length <= 1) {
    next[index] = pieces[0] ?? ''
    return next
  }
  next.splice(index, 1, ...pieces)
  return next
}

function draftOf(settings: HermesBotSettings): Draft {
  const collaborationDefaults: FleetSettings = {
    enabled: true,
    autoPlanner: true,
    approvalMode: 'auto-planned',
    defaultSessionScope: 'requester',
    maxGroupBots: 6,
    maxGroupRounds: 3,
    maxGroupMessages: 10,
    maxParallelRuns: 6,
    botRunMaxAttempts: 3,
    features: {
      dynamicRegistry: false,
      chatBotCreation: false,
      peerMessaging: false,
      managerAgent: false,
      savedWorkflows: false,
      externalRuntimes: false,
    },
  }
  const collaboration = settings.collaboration === undefined
    ? collaborationDefaults
    : {
        ...collaborationDefaults,
        ...settings.collaboration,
        features: { ...collaborationDefaults.features, ...settings.collaboration.features },
      }
  const profiles = settings.profiles ?? []
  return {
    enabled: settings.enabled,
    feishuEnabled: settings.feishu.enabled,
    appId: settings.feishu.appId,
    appSecret: '',
    domain: settings.feishu.domain,
    requireMention: settings.feishu.requireMention,
    userIds: [...settings.access.userIds],
    chatIds: [...settings.access.chatIds],
    pairingEnabled: settings.access.pairing !== false,
    collaboration: { ...collaboration, features: { ...collaboration.features } },
    profiles: profiles.map(profile => ({
      id: profile.id,
      title: profile.title,
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      soul: profile.soul,
      fleetRole: profile.fleetRole,
      sessionScope: profile.sessionScope,
      approvalRequired: profile.approvalRequired,
      enabled: profile.enabled,
      capabilitiesText: profile.capabilities.join(', '),
      skillsText: profile.skills.join(', '),
      allowedUserIdsText: profile.allowedUserIds.join(', '),
      allowedChatIdsText: profile.allowedChatIds.join(', '),
    })),
  }
}

function profileSettingsOf(draft: FleetProfileDraft): FleetProfileSettings {
  return {
    id: draft.id,
    title: draft.title,
    description: draft.description,
    provider: draft.provider,
    model: draft.model,
    soul: draft.soul,
    fleetRole: draft.fleetRole,
    sessionScope: draft.sessionScope,
    approvalRequired: draft.approvalRequired,
    enabled: draft.enabled,
    capabilities: splitIds(draft.capabilitiesText),
    skills: splitIds(draft.skillsText),
    allowedUserIds: splitIds(draft.allowedUserIdsText),
    allowedChatIds: splitIds(draft.allowedChatIdsText),
  }
}

class FeishuSetupController {
  private readonly store
  private disposed = false

  public constructor(_ctx: ClientContext) {
    this.store = createSnapshotStore<SetupState>({
      status: 'loading',
      writable: false,
      credential: emptyCredential(),
      diagnostics: emptyDiagnostics(),
      saving: false,
      diagnosing: false,
      pairingApproving: false,
      fleetApproving: false,
    })
    void this.refresh()
  }

  public snapshot = (): SetupState => this.store.getSnapshot()

  public subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  public async refresh(): Promise<void> {
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, { headers: { accept: 'application/json' } })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({
        status: 'ready',
        settings: data.settings,
        writable: data.writable,
        credential: data.credential,
        diagnostics: data.diagnostics,
        diagnosticsError: undefined,
        error: undefined,
      })
    } catch (error) {
      this.publish({ status: 'unavailable', error: `读取飞书机器人设置失败：${String(error)}` })
    }
  }

  public async refreshDiagnostics(): Promise<void> {
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, { headers: { accept: 'application/json' } })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({ diagnostics: data.diagnostics, diagnosticsError: undefined })
    } catch (error) {
      this.publish({ diagnosticsError: `读取消息诊断失败：${String(error)}` })
    }
  }

  public async save(draft: Draft): Promise<void> {
    const snapshot = this.snapshot()
    if (snapshot.status !== 'ready' || snapshot.settings === undefined) {
      this.publish({ error: '设置服务还没有准备好，请稍后再试。' })
      return
    }
    if (!snapshot.writable) {
      this.publish({ error: '当前 DSH 设置为只读，不能保存。' })
      return
    }
    const appId = draft.appId.trim()
    const discoveredUserId = snapshot.diagnostics.discovery?.candidate?.userId
    const userIds = normalizedRows(draft.userIds)
    if (discoveredUserId !== undefined && !userIds.includes(discoveredUserId)) userIds.push(discoveredUserId)
    const chatIds = normalizedRows(draft.chatIds)
    if (appId === '') {
      this.publish({ error: '请填写飞书 App ID。' })
      return
    }
    if (userIds.length === 0 && chatIds.length === 0 && !draft.pairingEnabled) {
      this.publish({ error: '请先开启“未知用户自动配对”，或填写一个用户 ID / 群聊 ID。' })
      return
    }
    if (draft.appSecret.trim() === '' && !snapshot.credential.configured) {
      this.publish({ error: '请填写飞书 App Secret。' })
      return
    }
    const profileIds = draft.profiles.map(profile => profile.id.trim())
    const invalidProfile = profileIds.find(id => id !== id.toLowerCase() || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id))
    if (invalidProfile !== undefined) {
      this.publish({ error: `Bot ID 不合法：${invalidProfile || '空白'}。只能使用小写字母、数字、下划线和短横线。` })
      return
    }
    if (new Set(profileIds).size !== profileIds.length) {
      this.publish({ error: 'Bot ID 不能重复。' })
      return
    }

    this.publish({ saving: true, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          settings: {
            enabled: draft.enabled,
            feishu: {
              enabled: draft.feishuEnabled,
              appId,
              domain: draft.domain,
              requireMention: draft.requireMention,
            },
            access: { userIds, chatIds, pairing: draft.pairingEnabled },
            collaboration: draft.collaboration,
            profiles: draft.profiles.map(profileSettingsOf),
          },
          ...(draft.appSecret.trim() === '' ? {} : { appSecret: draft.appSecret.trim() }),
        }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({
        status: 'ready',
        // Diagnose temporarily clears the server-side allowlist so that only
        // the one-time discovery command can authorize a message. Keep the
        // user's unsaved rows visible in the form until they click Save.
        settings: {
          ...data.settings,
          access: {
            ...data.settings.access,
            userIds: normalizedRows(draft.userIds),
            chatIds: normalizedRows(draft.chatIds),
          },
        },
        writable: data.writable,
        credential: data.credential,
        diagnostics: data.diagnostics,
        message: data.message ?? '已保存，机器人正在自动启动。请在飞书同一个聊天中发送 /new 开始新的会话，然后再正常使用。',
        error: undefined,
        diagnosticsError: undefined,
      })
    } catch (error) {
      this.publish({ error: `保存失败：${String(error)}` })
    } finally {
      this.publish({ saving: false })
    }
  }

  public async startDiscovery(draft: Draft): Promise<void> {
    const snapshot = this.snapshot()
    if (snapshot.status !== 'ready' || snapshot.settings === undefined) {
      this.publish({ error: '设置服务还没有准备好，请稍后再试。' })
      return
    }
    if (!snapshot.writable) {
      this.publish({ error: '当前 DSH 设置为只读，不能保存。' })
      return
    }
    const appId = draft.appId.trim()
    if (appId === '') {
      this.publish({ error: '请先填写飞书 App ID。' })
      return
    }
    if (draft.appSecret.trim() === '' && !snapshot.credential.configured) {
      this.publish({ error: '首次测试请填写飞书 App Secret。' })
      return
    }

    this.publish({ diagnosing: true, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'diagnose',
          settings: {
            enabled: draft.enabled,
            feishu: {
              enabled: draft.feishuEnabled,
              appId,
              domain: draft.domain,
              requireMention: draft.requireMention,
            },
            // The server also clears these fields. Keep the request explicit so
            // the temporary discovery state can never authorize an old ID.
            access: { userIds: [], chatIds: [], pairing: draft.pairingEnabled },
            collaboration: draft.collaboration,
            profiles: draft.profiles.map(profileSettingsOf),
          },
          ...(draft.appSecret.trim() === '' ? {} : { appSecret: draft.appSecret.trim() }),
        }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      const candidate = data.pairingCandidate
      this.publish({
        status: 'ready',
        settings: candidate?.userId === undefined
          ? data.settings
          : {
              ...data.settings,
              access: {
                ...data.settings.access,
                userIds: appendUniqueRow(data.settings.access.userIds, candidate.userId),
              },
            },
        writable: data.writable,
        credential: data.credential,
        diagnostics: data.diagnostics,
        message: data.message ?? '已启动连接测试。请按诊断区提示操作。',
        error: undefined,
        diagnosticsError: undefined,
      })
    } catch (error) {
      this.publish({ error: `连接测试失败：${String(error)}` })
    } finally {
      this.publish({ diagnosing: false })
    }
  }

  public async approvePairing(code: string): Promise<PairingCandidate | undefined> {
    const value = code.trim()
    if (value === '') {
      this.publish({ error: '请输入用户发来的配对码。' })
      return undefined
    }
    this.publish({ pairingApproving: true, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pairing_approve', pairingCode: value }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({
        status: 'ready',
        settings: data.settings,
        writable: data.writable,
        credential: data.credential,
        diagnostics: data.diagnostics,
        message: data.message ?? '配对成功。请在飞书同一个聊天中发送 /new 开始新的会话，然后再正常使用。',
        error: undefined,
        diagnosticsError: undefined,
      })
      return data.pairingCandidate
    } catch (error) {
      this.publish({ error: `配对失败：${String(error)}` })
      return undefined
    } finally {
      this.publish({ pairingApproving: false })
    }
  }

  public async revokePairing(platform: string, userId: string): Promise<boolean> {
    this.publish({ pairingApproving: true, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pairing_revoke', platform, userId }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({
        status: 'ready',
        settings: data.settings,
        writable: data.writable,
        credential: data.credential,
        diagnostics: data.diagnostics,
        message: data.message ?? '已取消该用户的配对权限。',
        error: undefined,
        diagnosticsError: undefined,
      })
      return true
    } catch (error) {
      this.publish({ error: `取消配对失败：${String(error)}` })
      return false
    } finally {
      this.publish({ pairingApproving: false })
    }
  }

  public async resolveFleetApproval(code: string, decision: 'approved' | 'rejected'): Promise<boolean> {
    this.publish({ fleetApproving: true, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'fleet_approval_resolve', approvalCode: code, decision }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({
        diagnostics: data.diagnostics,
        message: data.message ?? (decision === 'approved' ? '已批准 Fleet 操作。' : '已拒绝 Fleet 操作。'),
        diagnosticsError: undefined,
      })
      return true
    } catch (error) {
      this.publish({ error: `Fleet 审批失败：${String(error)}` })
      return false
    } finally {
      this.publish({ fleetApproving: false })
    }
  }

  public async updateDynamicBotStatus(botId: string, status: 'active' | 'disabled' | 'deleted'): Promise<boolean> {
    this.publish({ botRegistryAction: `${status}:${botId}`, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'bot_registry_status', botId, status }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({ diagnostics: data.diagnostics, message: data.message ?? '动态 Bot 状态已更新。', diagnosticsError: undefined })
      return true
    } catch (error) {
      this.publish({ error: `动态 Bot 操作失败：${String(error)}` })
      return false
    } finally {
      this.publish({ botRegistryAction: undefined })
    }
  }

  public async loadFleetTask(taskId: string): Promise<void> {
    this.publish({ fleetTaskAction: `detail:${taskId}`, error: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'fleet_task_detail', taskId }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      if (body.taskDetail === null || typeof body.taskDetail !== 'object' || Array.isArray(body.taskDetail)) {
        throw new Error('服务器返回的任务详情格式不正确。')
      }
      this.publish({ fleetTaskDetail: body.taskDetail as FleetTaskDetailView })
    } catch (error) {
      this.publish({ error: `读取任务详情失败：${String(error)}` })
    } finally {
      this.publish({ fleetTaskAction: undefined })
    }
  }

  public clearFleetTaskDetail(): void {
    this.publish({ fleetTaskDetail: undefined })
  }

  public async cancelFleetTask(taskId: string): Promise<boolean> {
    this.publish({ fleetTaskAction: `cancel:${taskId}`, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'fleet_task_cancel', taskId }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({ diagnostics: data.diagnostics, message: data.message ?? `已取消任务 ${taskId}。`, fleetTaskDetail: undefined })
      return true
    } catch (error) {
      this.publish({ error: `取消任务失败：${String(error)}` })
      return false
    } finally {
      this.publish({ fleetTaskAction: undefined })
    }
  }

  public async replayFleetTask(taskId: string): Promise<boolean> {
    this.publish({ fleetTaskAction: `replay:${taskId}`, error: undefined, message: undefined })
    try {
      const response = await fetch(HERMES_BOT_SETUP_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'fleet_task_replay', taskId }),
      })
      const body = await readRouteBody(response)
      if (!response.ok) throw new Error(errorFromBody(body, response.status))
      const data = setupResponseFromBody(body)
      this.publish({ diagnostics: data.diagnostics, message: data.message ?? '已创建新的重放任务。', fleetTaskDetail: undefined })
      return true
    } catch (error) {
      this.publish({ error: `重放任务失败：${String(error)}` })
      return false
    } finally {
      this.publish({ fleetTaskAction: undefined })
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
  }

  private publish(patch: Partial<SetupState>): void {
    if (this.disposed) return
    this.store.update((state) => {
      Object.assign(state, patch)
    })
  }
}

interface SetupResponse {
  readonly settings: HermesBotSettings
  readonly writable: boolean
  readonly credential: CredentialState
  readonly diagnostics: Diagnostics
  readonly message?: string
  readonly pairingCandidate?: PairingCandidate
}

async function readRouteBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => ({}))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function errorFromBody(body: Record<string, unknown>, status: number): string {
  return typeof body.error === 'string' ? body.error : `请求失败（HTTP ${String(status)}）。`
}

function setupResponseFromBody(body: Record<string, unknown>): SetupResponse {
  if (body.settings === null || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
    throw new Error('服务器返回的设置格式不正确。')
  }
  const credential = body.credential
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('服务器返回的凭据状态不正确。')
  }
  const record = credential as Record<string, unknown>
  return {
    settings: body.settings as HermesBotSettings,
    writable: body.writable === true,
    credential: {
      configured: record.configured === true,
      writable: record.writable === true,
      ...(typeof record.source === 'string' ? { source: record.source } : {}),
    },
    diagnostics: body.diagnostics !== null
      && typeof body.diagnostics === 'object'
      && !Array.isArray(body.diagnostics)
      ? body.diagnostics as Diagnostics
      : emptyDiagnostics(),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
    ...(body.pairingCandidate !== null
      && typeof body.pairingCandidate === 'object'
      && !Array.isArray(body.pairingCandidate)
      ? { pairingCandidate: body.pairingCandidate as PairingCandidate }
      : {}),
  }
}

type SettingsProps = PropsRuntime<'settings.section'> & { controller?: FeishuSetupController }

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="dsh-hermes-field"><span>{props.label}</span>{props.children}{props.hint === undefined ? null : <small>{props.hint}</small>}</label>
}

function IdListEditor({
  label,
  hint,
  values,
  onChange,
}: {
  label: string
  hint: string
  values: string[]
  onChange: (values: string[]) => void
}) {
  return (
    <div className="dsh-hermes-id-editor">
      <div className="dsh-hermes-id-editor-head">
        <div><span>{label}</span><small>{hint}</small></div>
        <span className="dsh-hermes-id-count">{values.length} 个</span>
      </div>
      {values.length === 0 ? <div className="dsh-hermes-id-empty">暂未添加{label}</div> : values.map((value, index) => (
        <div className="dsh-hermes-id-row" key={`${label}-${index}`}>
          <span className="dsh-hermes-id-index">{label} {index + 1}</span>
          <input
            value={value}
            onChange={event => { onChange(updateRowValue(values, index, event.target.value)) }}
            placeholder={label === '用户 ID' ? '例如 ou_…' : '例如 oc_…'}
            autoComplete="off"
          />
          <button type="button" className="dsh-hermes-id-remove" onClick={() => {
            onChange(values.filter((_, rowIndex) => rowIndex !== index))
          }}>删除</button>
        </div>
      ))}
      <button type="button" className="dsh-hermes-id-add" onClick={() => { onChange([...values, '']) }}>＋ 添加{label}</button>
    </div>
  )
}

function formatDiagnosticTime(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Date(value).toLocaleString()
}

function diagnosticDecisionLabel(value: string | undefined): string {
  if (value === 'accepted') return '已通过白名单'
  if (value === 'unauthorized') return '未通过白名单'
  if (value === 'duplicate') return '重复消息'
  return '—'
}

function newFleetProfile(profiles: readonly FleetProfileDraft[]): FleetProfileDraft {
  const ids = new Set(profiles.map(profile => profile.id))
  let index = 1
  while (ids.has(`bot-${index}`)) index += 1
  return {
    id: `bot-${index}`,
    title: `Bot ${index}`,
    description: '',
    provider: '',
    model: '',
    capabilitiesText: '',
    skillsText: '',
    soul: '',
    fleetRole: 'worker',
    sessionScope: 'requester',
    allowedUserIdsText: '',
    allowedChatIdsText: '',
    approvalRequired: false,
    enabled: true,
  }
}

function FleetProfileEditor({
  profiles,
  onChange,
}: {
  profiles: FleetProfileDraft[]
  onChange: (profiles: FleetProfileDraft[]) => void
}) {
  const updateProfile = (index: number, patch: Partial<FleetProfileDraft>): void => {
    onChange(profiles.map((profile, row) => row === index ? { ...profile, ...patch } : profile))
  }
  return (
    <div className="dsh-hermes-fleet-profiles">
      {profiles.length === 0 ? <div className="dsh-hermes-id-empty">还没有自定义 Bot；网关仍保留内置 default Bot。点击下方按钮即可组建 Fleet。</div> : profiles.map((profile, index) => (
        <div className="dsh-hermes-fleet-profile" key={`fleet-profile-${index}`}>
          <div className="dsh-hermes-fleet-profile-head">
            <div><strong>Bot {index + 1}</strong><code>@{profile.id || '未命名'}</code></div>
            <div className="dsh-hermes-action-row">
              <label className="dsh-hermes-mini-check"><input type="checkbox" checked={profile.enabled} onChange={event => { updateProfile(index, { enabled: event.target.checked }) }} />启用</label>
              <button type="button" className="dsh-hermes-id-remove" onClick={() => { onChange(profiles.filter((_, row) => row !== index)) }}>删除</button>
            </div>
          </div>
          <div className="dsh-hermes-grid">
            <Field label="Bot ID" hint="聊天中使用 @这个ID；只允许小写字母、数字、-、_"><input value={profile.id} onChange={event => { updateProfile(index, { id: event.target.value.toLowerCase() }) }} /></Field>
            <Field label="显示名称"><input value={profile.title} onChange={event => { updateProfile(index, { title: event.target.value }) }} /></Field>
            <Field label="Fleet 角色"><select value={profile.fleetRole} onChange={event => { updateProfile(index, { fleetRole: event.target.value as FleetProfileDraft['fleetRole'] }) }}><option value="worker">执行 Worker</option><option value="verifier">验证 Verifier</option><option value="synthesizer">汇总 Synthesizer</option><option value="generalist">通用 Generalist</option></select></Field>
            <Field label="会话隔离"><select value={profile.sessionScope} onChange={event => { updateProfile(index, { sessionScope: event.target.value as FleetProfileDraft['sessionScope'] }) }}><option value="requester">按使用者隔离（推荐）</option><option value="chat">按聊天隔离</option><option value="task">每个任务独立</option><option value="shared">所有人共享（有串话风险）</option></select></Field>
            <Field label="模型提供方" hint="留空则继承 DSH 默认"><input value={profile.provider} onChange={event => { updateProfile(index, { provider: event.target.value }) }} /></Field>
            <Field label="模型" hint="留空则继承 DSH 默认"><input value={profile.model} onChange={event => { updateProfile(index, { model: event.target.value }) }} /></Field>
            <Field label="能力标签" hint="逗号或换行分隔，Planner 会用它选 Bot"><input value={profile.capabilitiesText} onChange={event => { updateProfile(index, { capabilitiesText: event.target.value }) }} /></Field>
            <Field label="技能名称" hint="逗号或换行分隔"><input value={profile.skillsText} onChange={event => { updateProfile(index, { skillsText: event.target.value }) }} /></Field>
            <Field label="仅允许这些用户" hint="留空表示继承总白名单"><input value={profile.allowedUserIdsText} onChange={event => { updateProfile(index, { allowedUserIdsText: event.target.value }) }} /></Field>
            <Field label="仅允许这些群聊" hint="留空表示继承总白名单"><input value={profile.allowedChatIdsText} onChange={event => { updateProfile(index, { allowedChatIdsText: event.target.value }) }} /></Field>
          </div>
          <Field label="职责说明"><textarea value={profile.description} onChange={event => { updateProfile(index, { description: event.target.value }) }} /></Field>
          <Field label="SOUL / 身份提示"><textarea value={profile.soul} onChange={event => { updateProfile(index, { soul: event.target.value }) }} /></Field>
          <label className="dsh-hermes-check"><input type="checkbox" checked={profile.approvalRequired} onChange={event => { updateProfile(index, { approvalRequired: event.target.checked }) }} /><span>每次通过 Fleet 或 @mention 调用这个 Bot 都需要人工批准</span></label>
        </div>
      ))}
      <button type="button" className="dsh-hermes-id-add" onClick={() => { onChange([...profiles, newFleetProfile(profiles)]) }}>＋ 添加 Bot</button>
    </div>
  )
}

function FleetStatusPanel({
  diagnostics,
  approving,
  taskAction,
  taskDetail,
  registryAction,
  onResolve,
  onRefresh,
  onDetail,
  onCancel,
  onReplay,
  onCloseDetail,
  onRegistryStatus,
}: {
  diagnostics: Diagnostics
  approving: boolean
  taskAction?: string | undefined
  taskDetail?: FleetTaskDetailView | undefined
  registryAction?: string | undefined
  onResolve: (code: string, decision: 'approved' | 'rejected') => void
  onRefresh: () => void
  onDetail: (taskId: string) => void
  onCancel: (taskId: string) => void
  onReplay: (taskId: string) => void
  onCloseDetail: () => void
  onRegistryStatus: (botId: string, status: 'active' | 'disabled' | 'deleted') => void
}) {
  const fleet = diagnostics.fleet
  const approvals = (fleet?.approvals ?? []).filter(approval => approval.status === 'pending')
  const workflows = fleet?.workflows ?? []
  const tasks = fleet?.tasks ?? []
  const deadLetters = fleet?.deadLetters ?? []
  const registryBots = fleet?.registryBots ?? []
  const [registryFilter, setRegistryFilter] = useState<'all' | 'joined' | 'blocked' | 'busy' | 'draft' | 'disabled' | 'deleted'>('all')
  const filteredRegistryBots = registryBots.filter(bot => {
    if (registryFilter === 'all') return true
    if (registryFilter === 'joined') return bot.fleetMembership === 'joined'
    if (registryFilter === 'blocked') return bot.fleetMembership === 'blocked'
    if (registryFilter === 'busy') return bot.busy === true
    return bot.status === registryFilter
  })
  return (
    <section className="dsh-hermes-panel">
      <div className="dsh-hermes-diagnostic-head"><div><h3>Bot Fleet 控制台</h3><p className="dsh-hermes-muted">统一查看 Bot、任务、工作流、审批和死信；数据来自本机持久化状态。</p></div><button type="button" className="dsh-hermes-secondary" onClick={onRefresh}>刷新 Fleet</button></div>
      <div className="dsh-hermes-diagnostic-grid">
        <div><span>可用 Bot</span><strong>{String(diagnostics.bots?.length ?? 0)}</strong></div>
        <div><span>正在运行</span><strong>{String(diagnostics.collaboration?.activeRuns ?? 0)}</strong></div>
        <div><span>待审批</span><strong>{String(approvals.length)}</strong></div>
        <div><span>死信</span><strong>{String(deadLetters.length)}</strong></div>
      </div>
      <div className="dsh-hermes-fleet-roster">
        {(diagnostics.bots ?? []).map(bot => <div key={bot.id} className="dsh-hermes-fleet-chip"><strong>@{bot.id}</strong><span>{bot.fleetRole ?? 'generalist'} · {bot.sessionScope ?? 'requester'}</span></div>)}
      </div>
      <div className="dsh-hermes-dynamic-bots">
        <div><strong>动态 Bot 注册表</strong><span className="dsh-hermes-muted">对话创建的 Bot 会先成为草稿；确认后才进入上面的可用 roster。</span><label className="dsh-hermes-mini-check">筛选 <select value={registryFilter} onChange={event => { setRegistryFilter(event.target.value as typeof registryFilter) }}><option value="all">全部（{registryBots.length}）</option><option value="joined">已加入 Fleet</option><option value="blocked">加入受阻</option><option value="busy">正在运行</option><option value="draft">草稿</option><option value="disabled">已停用</option><option value="deleted">已删除</option></select></label></div>
        {registryBots.length === 0 ? <span className="dsh-hermes-muted">暂无动态 Bot。启用对话创建后，可在飞书发送 <code>/bot create analyst 数据分析师</code>。</span> : filteredRegistryBots.length === 0 ? <span className="dsh-hermes-muted">当前筛选没有匹配的动态 Bot。</span> : filteredRegistryBots.map(bot => {
          const botId = bot.id ?? ''
          const handle = bot.handle ?? 'bot'
          const busy = registryAction !== undefined || approving
          const activity = bot.busy === true ? `忙碌（${String(bot.activeRuns ?? 0)} 个 Run）` : '空闲'
          const failure = bot.lastFailure?.error === undefined ? '' : ` · 最近失败：${bot.lastFailure.error}`
          return <div className="dsh-hermes-fleet-row" key={botId || handle}><div><strong>@{handle} · {bot.title ?? handle}</strong><span>{bot.status} · {bot.fleetRole ?? 'generalist'} · v{String(bot.version ?? 1)} / r{String(bot.revision ?? 1)} · {bot.membershipReason ?? (bot.runtimeReady ? `已自动加入 Fleet（dynamic r${String(bot.runtimeRevision ?? bot.revision ?? 1)}）` : bot.blockedReason ?? '尚未加入 Fleet')} · {activity}{failure}</span></div><div className="dsh-hermes-action-row">
            {bot.status === 'draft' && bot.activationCode !== undefined ? <button type="button" className="dsh-hermes-secondary" disabled={busy} onClick={() => { onResolve(bot.activationCode!, 'approved') }}>确认并激活</button> : null}
            {bot.status === 'active' ? <button type="button" className="dsh-hermes-secondary" disabled={busy || botId === ''} onClick={() => { onRegistryStatus(botId, 'disabled') }}>停用</button> : null}
            {bot.status === 'disabled' ? <button type="button" className="dsh-hermes-secondary" disabled={busy || botId === ''} onClick={() => { onRegistryStatus(botId, 'active') }}>重新启用</button> : null}
            {bot.status !== 'deleted' ? <button type="button" className="dsh-hermes-danger" disabled={busy || botId === ''} onClick={() => { if (window.confirm(`确定删除 @${handle}？该 ID 将不能重新使用，但审计历史会保留。`)) onRegistryStatus(botId, 'deleted') }}>删除</button> : null}
          </div></div>
        })}
      </div>
      <div className="dsh-hermes-fleet-columns">
        <div><strong>待审批</strong>{approvals.length === 0 ? <span className="dsh-hermes-muted">暂无</span> : approvals.map(approval => <div className="dsh-hermes-fleet-row" key={approval.id}><div><code>{approval.code}</code><span>{approval.summary ?? approval.kind}</span></div><div className="dsh-hermes-action-row"><button type="button" className="dsh-hermes-secondary" disabled={approving || approval.code === undefined} onClick={() => { if (approval.code) onResolve(approval.code, 'approved') }}>批准</button><button type="button" className="dsh-hermes-secondary" disabled={approving || approval.code === undefined} onClick={() => { if (approval.code) onResolve(approval.code, 'rejected') }}>拒绝</button></div></div>)}</div>
        <div><strong>最近工作流</strong>{workflows.length === 0 ? <span className="dsh-hermes-muted">暂无</span> : workflows.slice(0, 6).map(workflow => <div className="dsh-hermes-fleet-row" key={workflow.id}><div><code>{workflow.id}</code><span>{workflow.status} · {(workflow.workerBotIds ?? []).map(id => '@' + id).join('、')}</span></div></div>)}</div>
        <div><strong>最近任务</strong>{tasks.length === 0 ? <span className="dsh-hermes-muted">暂无</span> : tasks.slice(0, 10).map(task => {
          const taskId = task.id ?? ''
          const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
          return <div className="dsh-hermes-fleet-row" key={taskId}><div><code>{taskId}</code><span>{task.status} · {task.title}</span></div><div className="dsh-hermes-action-row"><button type="button" className="dsh-hermes-secondary" disabled={taskId === '' || taskAction !== undefined} onClick={() => { onDetail(taskId) }}>详情</button>{terminal ? <button type="button" className="dsh-hermes-secondary" disabled={taskId === '' || taskAction !== undefined} onClick={() => { onReplay(taskId) }}>重放</button> : <button type="button" className="dsh-hermes-danger" disabled={taskId === '' || taskAction !== undefined} onClick={() => { if (window.confirm(`确定取消任务 ${taskId}？正在运行的 Bot 会立即停止。`)) onCancel(taskId) }}>取消</button>}</div></div>
        })}</div>
        <div><strong>死信</strong>{deadLetters.length === 0 ? <span className="dsh-hermes-muted">暂无</span> : deadLetters.slice(0, 6).map(item => <div className="dsh-hermes-fleet-row" key={item.id}><div><code>{item.envelope?.taskId ?? item.id}</code><span>@{item.envelope?.to} · {item.lastError}</span></div></div>)}</div>
      </div>
      {taskDetail === undefined ? null : <div className="dsh-hermes-task-detail">
        <div className="dsh-hermes-diagnostic-head"><div><h4>任务详情</h4><code>{taskDetail.task.id}</code></div><button type="button" className="dsh-hermes-secondary" onClick={onCloseDetail}>关闭</button></div>
        <div className="dsh-hermes-task-meta"><span>状态：{taskDetail.task.status}</span><span>当前 Bot：@{taskDetail.task.assignedTo}</span><span>Runs：{taskDetail.runs.length}</span><span>Handoffs：{taskDetail.handoffs.length}</span></div>
        <strong>{taskDetail.task.title}</strong>
        <div><small>原始任务</small><pre>{taskDetail.task.instruction}</pre></div>
        {taskDetail.task.result === undefined ? null : <div><small>最终结果</small><pre>{taskDetail.task.result}</pre></div>}
        {taskDetail.task.error === undefined ? null : <div><small>错误</small><pre>{taskDetail.task.error}</pre></div>}
        <div><small>运行记录</small>{taskDetail.runs.map(run => <div className="dsh-hermes-task-run" key={run.id}><code>{run.id}</code><span>@{run.botId} · {run.phase ?? 'direct'} · 第 {run.attempt} 次 · {run.status}</span>{run.error === undefined ? null : <em>{run.error}</em>}</div>)}</div>
        <div><small>最近审计</small>{taskDetail.audits.slice(-20).reverse().map(audit => <div className="dsh-hermes-task-run" key={audit.id}><span>{new Date(audit.at).toLocaleString()} · {audit.action} · {audit.actor}</span></div>)}</div>
      </div>}
    </section>
  )
}

function DiagnosticPanel({
  diagnostics,
  error,
  onRefresh,
}: {
  diagnostics: Diagnostics
  error?: string | undefined
  onRefresh: () => void
}) {
  const feishu = diagnostics.transports?.feishu
  const event = feishu?.inbound?.last ?? null
  const decision = diagnostics.inbound?.last ?? null
  const userId = decision?.userId ?? event?.userId
  const chatId = decision?.chatId ?? event?.chatId
  const connected = feishu?.connected === true
  const received = feishu?.inbound?.received ?? 0
  const accepted = diagnostics.inbound?.accepted ?? 0
  const unauthorized = diagnostics.inbound?.unauthorized ?? 0
  const discovery = diagnostics.discovery
  const candidate = discovery?.candidate

  return (
    <section className="dsh-hermes-panel dsh-hermes-diagnostic">
      <div className="dsh-hermes-diagnostic-head">
        <div><h3>收到消息诊断</h3><p className="dsh-hermes-muted">只保存在内存中，重启 DSH 后会清零；不会记录消息正文或 App Secret。</p></div>
        <button type="button" className="dsh-hermes-secondary" onClick={onRefresh}>刷新诊断</button>
      </div>
      {error === undefined ? null : <div className="dsh-hermes-alert dsh-hermes-error">{error}</div>}
      <div className="dsh-hermes-diagnostic-grid">
        <div><span>长连接</span><strong>{feishu === undefined ? '未发现飞书传输' : connected ? '已连接' : feishu.running ? '正在连接' : '未连接'}</strong></div>
        <div><span>收到事件</span><strong>{String(received)}</strong></div>
        <div><span>通过白名单</span><strong>{String(accepted)}</strong></div>
        <div><span>被白名单拦截</span><strong>{String(unauthorized)}</strong></div>
      </div>
      {discovery?.active && discovery.command !== undefined ? (
        <div className="dsh-hermes-alert dsh-hermes-notice">连接测试已启动。请确认长连接显示“已连接”，然后在飞书私聊机器人发送：<code>{discovery.command}</code></div>
      ) : null}
      {candidate?.userId === undefined ? null : (
        <div className="dsh-hermes-alert dsh-hermes-success">已识别并自动填入用户 UID：<code>{candidate.userId}</code>。现在点击“保存并启动”；保存成功后，请在飞书同一个聊天中发送 <code>/new</code> 开始新的会话。</div>
      )}
      {event === null && decision === null ? (
        <div className="dsh-hermes-diagnostic-empty">目前还没有收到飞书事件。请先点击“刷新诊断”，再给机器人发一条新消息。</div>
      ) : (
        <div className="dsh-hermes-diagnostic-details">
          <div><span>实际收到的 user/open_id</span><code>{userId ?? '—'}</code></div>
          <div><span>实际收到的群聊 ID</span><code>{chatId ?? '—'}</code></div>
          <div><span>是否 @机器人</span><strong>{event?.mentionedBot === undefined ? '—' : event.mentionedBot ? '是' : '否'}</strong></div>
          <div><span>白名单判断</span><strong>{diagnosticDecisionLabel(decision?.decision)}</strong></div>
          <div><span>诊断原因</span><strong>{decision?.reason ?? event?.reason ?? '—'}</strong></div>
          <div><span>最近时间</span><strong>{formatDiagnosticTime(decision?.receivedAt ?? event?.receivedAt)}</strong></div>
        </div>
      )}
      {feishu?.lastError === undefined ? null : <div className="dsh-hermes-alert dsh-hermes-error">最近一次错误：{feishu.lastError}</div>}
    </section>
  )
}

function SettingsSection({ controller }: SettingsProps) {
  if (controller === undefined) return null
  return <LoadedSettings controller={controller} />
}

function LoadedSettings({ controller }: { controller: FeishuSetupController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const settings = state.settings
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [draftError, setDraftError] = useState<string | undefined>(undefined)
  const [pairingCode, setPairingCode] = useState('')

  useEffect(() => {
    if (settings !== undefined) setDraft(draftOf(settings))
  }, [settings])

  const discoveredUserId = state.diagnostics.discovery?.candidate?.userId
  useEffect(() => {
    if (discoveredUserId === undefined) return
    setDraft(current => {
      if (current === undefined || normalizedRows(current.userIds).includes(discoveredUserId)) return current
      return { ...current, userIds: appendUniqueRow(current.userIds, discoveredUserId) }
    })
  }, [discoveredUserId])

  useEffect(() => {
    void controller.refreshDiagnostics()
    const timer = window.setInterval(() => { void controller.refreshDiagnostics() }, 2_000)
    return () => window.clearInterval(timer)
  }, [controller])

  if (state.status === 'unavailable') {
    return <div className="dsh-hermes-settings"><div className="dsh-hermes-alert dsh-hermes-error">{state.error ?? '当前 DSH 没有提供可用的设置服务。'}</div></div>
  }
  if (state.status === 'loading' || draft === undefined) {
    return <div className="dsh-hermes-settings"><div className="dsh-hermes-loading">正在读取飞书机器人设置…</div></div>
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft(current => current === undefined ? current : { ...current, [key]: value })
    setDraftError(undefined)
  }
  const save = (): void => {
    try {
      setDraftError(undefined)
      void controller.save(draft)
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error))
    }
  }
  const updateCollaboration = <K extends keyof FleetSettings>(key: K, value: FleetSettings[K]): void => {
    setDraft(current => current === undefined ? current : { ...current, collaboration: { ...current.collaboration, [key]: value } })
    setDraftError(undefined)
  }
  const updateFleetFeature = (key: keyof FleetSettings['features'], value: boolean): void => {
    setDraft(current => current === undefined ? current : {
      ...current,
      collaboration: {
        ...current.collaboration,
        features: { ...current.collaboration.features, [key]: value },
      },
    })
    setDraftError(undefined)
  }
  const approvePairing = (): void => {
    void controller.approvePairing(pairingCode).then(candidate => {
      if (candidate?.userId !== undefined) {
        setDraft(current => current === undefined
          ? current
          : { ...current, userIds: appendUniqueRow(current.userIds, candidate.userId!) })
      }
      if (candidate !== undefined) setPairingCode('')
    })
  }
  const removeUserFromDraft = (userId: string): void => {
    setDraft(current => current === undefined
      ? current
      : { ...current, userIds: current.userIds.flatMap(value => splitIds(value).filter(item => item !== userId)) })
    setDraftError(undefined)
  }
  const revokeAuthorizedUser = (item: AuthorizedUserRow): void => {
    if (!item.paired) {
      removeUserFromDraft(item.userId)
      return
    }
    void controller.revokePairing(item.platform, item.userId).then(removed => {
      if (removed) removeUserFromDraft(item.userId)
    })
  }

  const authorizedUsers: AuthorizedUserRow[] = normalizedRows(draft.userIds).map(userId => ({
    userId,
    platform: 'feishu',
    allowlisted: true,
    paired: false,
  }))
  for (const pairing of state.diagnostics.pairing?.approved ?? []) {
    if (pairing.userId === undefined) continue
    const existing = authorizedUsers.find(item => item.userId === pairing.userId)
    if (existing === undefined) {
      authorizedUsers.push({
        userId: pairing.userId,
        platform: pairing.platform ?? 'feishu',
        allowlisted: false,
        paired: true,
      })
    } else {
      existing.paired = true
      existing.platform = pairing.platform ?? existing.platform
    }
  }

  return (
    <div className="dsh-hermes-settings">
      <header className="dsh-hermes-header">
        <div><span className="dsh-hermes-kicker">DeepSeek Harness 插件</span><h2>飞书机器人</h2><p>填好下面的信息，点击“保存并启动”；保存成功后，请在飞书同一个聊天中发送 <code>/new</code> 开始新的会话。</p></div>
        <span className={`dsh-hermes-badge ${state.credential.configured ? 'ok' : 'missing'}`}>{state.credential.configured ? '密钥已配置' : '等待密钥'}</span>
      </header>
      <div className="dsh-hermes-alert dsh-hermes-notice">App Secret 只保存到本机的 DSH 凭据库，页面不会回显它，也不会写进项目文件。</div>
      {!state.writable ? <div className="dsh-hermes-alert dsh-hermes-warning">当前设置服务是只读的，暂时不能保存。</div> : null}
      {draftError === undefined ? null : <div className="dsh-hermes-alert dsh-hermes-error">{draftError}</div>}
      {state.error === undefined ? null : <div className="dsh-hermes-alert dsh-hermes-error">{state.error}</div>}
      {state.message === undefined ? null : <div className="dsh-hermes-alert dsh-hermes-success">{state.message}</div>}

      <section className="dsh-hermes-panel">
        <h3>飞书应用</h3>
        <div className="dsh-hermes-grid">
          <Field label="App ID" hint="例如 cli_xxxxxxxxxxxx"><input value={draft.appId} onChange={event => { update('appId', event.target.value) }} autoComplete="off" /></Field>
          <Field label="App Secret" hint={state.credential.configured ? '已经有密钥；留空表示保持原密钥' : '在飞书开放平台应用详情中复制'}><input type="password" value={draft.appSecret} onChange={event => { update('appSecret', event.target.value) }} autoComplete="new-password" /></Field>
          <Field label="平台"><select value={draft.domain} onChange={event => { update('domain', event.target.value as Draft['domain']) }}><option value="feishu">飞书</option><option value="lark">Lark</option></select></Field>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.feishuEnabled} onChange={event => { update('feishuEnabled', event.target.checked) }} /><span>启用飞书机器人</span></label>
        </div>
      </section>

      <section className="dsh-hermes-panel">
        <h3>谁可以使用</h3>
        <p className="dsh-hermes-muted">这里是长期白名单。每个用户或群聊都有独立的输入框，保存后会一直保留；安全配对和一键识别到的新用户会自动追加，不会覆盖已有用户。群聊里默认需要 @机器人。</p>
        <div className="dsh-hermes-grid">
          <IdListEditor label="用户 ID" hint="推荐点击下方“一键测试并自动识别 UID”，不需要手动查 ou_…" values={draft.userIds} onChange={values => { update('userIds', values) }} />
          <IdListEditor label="群聊 ID" hint="飞书常见格式：oc_…；一个群聊一行" values={draft.chatIds} onChange={values => { update('chatIds', values) }} />
        </div>
        <div className="dsh-hermes-action-row">
          <button type="button" className="dsh-hermes-secondary" disabled={!state.writable || state.saving || state.diagnosing} onClick={() => { void controller.startDiscovery(draft) }}>{state.diagnosing ? '正在测试连接…' : '一键测试并自动识别 UID'}</button>
          {state.diagnostics.discovery?.candidate?.userId === undefined ? null : <button type="button" className="dsh-hermes-secondary" onClick={() => { setDraft(current => current === undefined ? current : { ...current, userIds: appendUniqueRow(current.userIds, state.diagnostics.discovery?.candidate?.userId ?? '') }) }}>再次追加检测到的 UID</button>}
          <span className="dsh-hermes-muted">首次使用仍需填写 App ID 和 App Secret；密钥只保存在本机凭据库。</span>
        </div>
        <label className="dsh-hermes-check"><input type="checkbox" checked={draft.pairingEnabled} onChange={event => { update('pairingEnabled', event.target.checked) }} /><span>未知用户私聊时自动回复一次性配对码</span></label>
        <label className="dsh-hermes-check"><input type="checkbox" checked={draft.requireMention} onChange={event => { update('requireMention', event.target.checked) }} /><span>群聊消息必须 @机器人</span></label>
      </section>

      <section className="dsh-hermes-panel">
        <h3>安全配对</h3>
        <p className="dsh-hermes-muted">陌生用户私聊机器人后，会收到一个 8 位配对码。让对方把配对码发给你，在这里确认；确认前不会把对方的消息交给 Agent。</p>
        <div className="dsh-hermes-action-row">
          <input className="dsh-hermes-pairing-input" value={pairingCode} onChange={event => { setPairingCode(event.target.value.toUpperCase()) }} placeholder="输入配对码，例如 ABCD2345" autoComplete="off" />
          <button type="button" className="dsh-hermes-secondary" disabled={!state.writable || state.saving || state.pairingApproving || pairingCode.trim() === ''} onClick={approvePairing}>{state.pairingApproving ? '正在确认…' : '确认配对并自动填入 UID'}</button>
        </div>
        <p className="dsh-hermes-muted">当前待确认配对：{String(state.diagnostics.pairing?.pending?.length ?? 0)} 个。配对成功后，对方可以立即使用；确认到的 UID 会自动追加到上面的用户 ID 列表，点击“保存并启动”即可长期保存。</p>
        <div className="dsh-hermes-pairing-approved">
          <span className="dsh-hermes-muted">当前已授权用户</span>
          {authorizedUsers.length === 0 ? <div className="dsh-hermes-id-empty">暂无已授权用户</div> : authorizedUsers.map(item => {
            const action = item.paired && item.allowlisted ? '全部解除' : item.paired ? '取消配对' : '移出白名单'
            const source = item.paired && item.allowlisted ? '白名单 + 安全配对' : item.paired ? '安全配对' : '用户 ID 白名单'
            return <div className="dsh-hermes-pairing-approved-row" key={`${item.platform}:${item.userId}`}><div className="dsh-hermes-authorized-user"><code>{item.userId}</code><span>{source}</span></div><button type="button" className="dsh-hermes-secondary" disabled={state.pairingApproving} onClick={() => { revokeAuthorizedUser(item) }}>{action}</button></div>
          })}
        </div>
      </section>

      <section className="dsh-hermes-panel">
        <div className="dsh-hermes-diagnostic-head"><div><h3>Bot Fleet 设置</h3><p className="dsh-hermes-muted"><code>/fleet 任务</code> 会按能力并行分派，再进行验证和汇总；显式 <code>@bot</code> 仍可创建单 Bot 或顺序协作房间。</p></div><span className={`dsh-hermes-badge ${draft.collaboration.enabled ? 'ok' : 'missing'}`}>{draft.collaboration.enabled ? 'Fleet 已启用' : 'Fleet 已停用'}</span></div>
        <div className="dsh-hermes-grid">
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.enabled} onChange={event => { updateCollaboration('enabled', event.target.checked) }} /><span>启用 Bot Fleet</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.autoPlanner} onChange={event => { updateCollaboration('autoPlanner', event.target.checked) }} /><span>启用自动 Planner</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.features.dynamicRegistry} onChange={event => { updateFleetFeature('dynamicRegistry', event.target.checked); if (!event.target.checked) updateFleetFeature('chatBotCreation', false) }} /><span>启用动态 Bot 注册表</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.features.chatBotCreation} disabled={!draft.collaboration.features.dynamicRegistry} onChange={event => { updateFleetFeature('chatBotCreation', event.target.checked) }} /><span>允许在对话中创建 Bot</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.features.peerMessaging} onChange={event => { updateFleetFeature('peerMessaging', event.target.checked) }} /><span>允许 Bot 间受控 @协作</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.features.managerAgent} onChange={event => { updateFleetFeature('managerAgent', event.target.checked) }} /><span>允许 @manager 规划委派</span></label>
          <label className="dsh-hermes-check"><input type="checkbox" checked={draft.collaboration.features.savedWorkflows} onChange={event => { updateFleetFeature('savedWorkflows', event.target.checked) }} /><span>启用版本化 Workflow API</span></label>
          <Field label="审批策略"><select value={draft.collaboration.approvalMode} onChange={event => { updateCollaboration('approvalMode', event.target.value as FleetSettings['approvalMode']) }}><option value="auto-planned">自动计划需要批准（推荐）</option><option value="multi-bot">多 Bot 才需要批准</option><option value="always">所有 Fleet 操作都批准</option><option value="never">不需要批准</option></select></Field>
          <Field label="默认会话隔离"><select value={draft.collaboration.defaultSessionScope} onChange={event => { updateCollaboration('defaultSessionScope', event.target.value as FleetSettings['defaultSessionScope']) }}><option value="requester">按使用者隔离（推荐）</option><option value="chat">按聊天隔离</option><option value="task">按任务隔离</option><option value="shared">共享上下文（有串话风险）</option></select></Field>
          <Field label="协作 Bot 上限"><input type="number" min="2" max="6" value={draft.collaboration.maxGroupBots} onChange={event => { updateCollaboration('maxGroupBots', Number(event.target.value)) }} /></Field>
          <Field label="顺序协作轮数"><input type="number" min="1" max="3" value={draft.collaboration.maxGroupRounds} onChange={event => { updateCollaboration('maxGroupRounds', Number(event.target.value)) }} /></Field>
          <Field label="房间消息上限"><input type="number" min="2" max="100" value={draft.collaboration.maxGroupMessages} onChange={event => { updateCollaboration('maxGroupMessages', Number(event.target.value)) }} /></Field>
          <Field label="最大并行 Run"><input type="number" min="1" max="6" value={draft.collaboration.maxParallelRuns} onChange={event => { updateCollaboration('maxParallelRuns', Number(event.target.value)) }} /></Field>
          <Field label="Bot 失败重试次数"><input type="number" min="1" max="10" value={draft.collaboration.botRunMaxAttempts} onChange={event => { updateCollaboration('botRunMaxAttempts', Number(event.target.value)) }} /></Field>
        </div>
      </section>

      <section className="dsh-hermes-panel">
        <div><h3>Bot roster</h3><p className="dsh-hermes-muted">每个 Bot 都有独立模型、角色、能力、SOUL、会话隔离和二级权限。用户必须先通过上面的总白名单/配对，再通过这里的 Bot 权限。</p></div>
        <FleetProfileEditor profiles={draft.profiles} onChange={profiles => { update('profiles', profiles) }} />
      </section>

      <FleetStatusPanel
        diagnostics={state.diagnostics}
        approving={state.fleetApproving}
        taskAction={state.fleetTaskAction}
        taskDetail={state.fleetTaskDetail}
        registryAction={state.botRegistryAction}
        onResolve={(code, decision) => { void controller.resolveFleetApproval(code, decision) }}
        onRefresh={() => { void controller.refreshDiagnostics() }}
        onDetail={taskId => { void controller.loadFleetTask(taskId) }}
        onCancel={taskId => { void controller.cancelFleetTask(taskId) }}
        onReplay={taskId => { void controller.replayFleetTask(taskId) }}
        onCloseDetail={() => { controller.clearFleetTaskDetail() }}
        onRegistryStatus={(botId, status) => { void controller.updateDynamicBotStatus(botId, status) }}
      />

      <DiagnosticPanel diagnostics={state.diagnostics} error={state.diagnosticsError} onRefresh={() => { void controller.refreshDiagnostics() }} />

      <section className="dsh-hermes-panel dsh-hermes-actions">
        <label className="dsh-hermes-check"><input type="checkbox" checked={draft.enabled} onChange={event => { update('enabled', event.target.checked) }} /><span>保存后启用机器人</span></label>
        <div className="dsh-hermes-alert dsh-hermes-notice">重要：保存成功后，请在飞书同一个聊天中发送 <code>/new</code>，新会话建立后设置才会完全生效。</div>
        <button type="button" className="dsh-hermes-primary" disabled={!state.writable || state.saving || state.diagnosing} onClick={save}>{state.saving ? '正在保存…' : '保存并启动'}</button>
      </section>
    </div>
  )
}

const CSS = `
.dsh-hermes-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.dsh-hermes-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:8px 2px}.dsh-hermes-header h2{font-size:25px;letter-spacing:-.025em;margin:3px 0 6px}.dsh-hermes-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}.dsh-hermes-kicker{font-size:10px;letter-spacing:.1em;color:#6758d4;font-weight:700}.dsh-hermes-badge{font-size:10px;padding:4px 8px;border-radius:999px;font-weight:650;white-space:nowrap}.dsh-hermes-badge.ok{background:rgba(48,154,100,.12);color:#267d52}.dsh-hermes-badge.missing{background:rgba(205,72,72,.1);color:#aa3939}
.dsh-hermes-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}.dsh-hermes-notice{background:rgba(92,108,213,.09);color:#5149a6}.dsh-hermes-warning{background:rgba(224,162,55,.12);color:#986818}.dsh-hermes-error{background:rgba(205,72,72,.1);color:#aa3939}.dsh-hermes-success{background:rgba(48,154,100,.1);color:#267d52}.dsh-hermes-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.dsh-hermes-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}.dsh-hermes-panel h3{font-size:14px;margin:0}.dsh-hermes-muted{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:0}.dsh-hermes-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dsh-hermes-field{display:grid;gap:6px;align-content:start}.dsh-hermes-field>span{font-size:11px;font-weight:600}.dsh-hermes-field>small{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.4}.dsh-hermes-field input,.dsh-hermes-field select,.dsh-hermes-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px}.dsh-hermes-field input,.dsh-hermes-field select{height:36px}.dsh-hermes-field textarea{resize:vertical;min-height:76px}.dsh-hermes-check{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px;font-size:12px;cursor:pointer}.dsh-hermes-check input{accent-color:#6758d4}.dsh-hermes-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-hermes-primary{border:0;border-radius:999px;background:#6758d4;color:#fff;padding:9px 16px;font:inherit;font-size:12px;font-weight:650;cursor:pointer}.dsh-hermes-primary:disabled{opacity:.5;cursor:not-allowed}@media(max-width:720px){.dsh-hermes-header{display:grid}.dsh-hermes-grid{grid-template-columns:1fr}.dsh-hermes-actions{align-items:stretch;flex-direction:column}}
 .dsh-hermes-action-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-hermes-action-row .dsh-hermes-muted{flex:1 1 260px}.dsh-hermes-pairing-input{height:36px;min-width:220px;flex:1 1 240px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px;text-transform:uppercase}.dsh-hermes-pairing-approved{display:grid;gap:7px}.dsh-hermes-pairing-approved-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-pairing-approved-row code{font-size:11px;overflow-wrap:anywhere}.dsh-hermes-danger{border:1px solid rgba(190,60,60,.35);border-radius:999px;background:rgba(205,72,72,.08);color:#aa3939;padding:7px 12px;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}.dsh-hermes-secondary:disabled,.dsh-hermes-danger:disabled{opacity:.5;cursor:not-allowed}
 .dsh-hermes-id-editor{display:grid;gap:8px;align-content:start}.dsh-hermes-id-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-hermes-id-editor-head>div{display:grid;gap:3px}.dsh-hermes-id-editor-head span{font-size:11px;font-weight:600}.dsh-hermes-id-editor-head small{font-size:10px;line-height:1.4;color:var(--dsw-alias-fg-muted,#77736d)}.dsh-hermes-id-count{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d);white-space:nowrap}.dsh-hermes-id-row{display:grid;grid-template-columns:74px minmax(0,1fr) auto;align-items:center;gap:7px}.dsh-hermes-id-index{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d);white-space:nowrap}.dsh-hermes-id-row input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px}.dsh-hermes-id-remove{border:0;background:transparent;color:var(--dsw-alias-fg-muted,#77736d);font:inherit;font-size:11px;padding:6px 3px;cursor:pointer}.dsh-hermes-id-add{justify-self:start;border:1px dashed var(--dsw-alias-border-subtle,#d9d5ce);border-radius:999px;background:transparent;color:inherit;padding:6px 10px;font:inherit;font-size:11px;cursor:pointer}.dsh-hermes-id-empty{padding:9px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:11px;color:var(--dsw-alias-fg-muted,#77736d)}.dsh-hermes-authorized-user{display:grid;gap:3px;min-width:0}.dsh-hermes-authorized-user code{font-size:11px;overflow-wrap:anywhere}.dsh-hermes-authorized-user span{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}
  .dsh-hermes-fleet-profiles{display:grid;gap:10px}.dsh-hermes-fleet-profile{display:grid;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-fleet-profile-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.dsh-hermes-fleet-profile-head>div:first-child{display:flex;align-items:center;gap:8px}.dsh-hermes-fleet-profile-head strong{font-size:12px}.dsh-hermes-fleet-profile-head code{font-size:10px;color:#6758d4}.dsh-hermes-mini-check{display:flex;align-items:center;gap:4px;font-size:10px}.dsh-hermes-fleet-roster{display:flex;flex-wrap:wrap;gap:7px}.dsh-hermes-fleet-chip{display:grid;gap:2px;padding:7px 9px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-fleet-chip strong{font-size:11px}.dsh-hermes-fleet-chip span{font-size:9px;color:var(--dsw-alias-fg-muted,#77736d)}.dsh-hermes-dynamic-bots{display:grid;gap:8px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-dynamic-bots>div:first-child{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.dsh-hermes-dynamic-bots strong{font-size:11px}.dsh-hermes-fleet-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dsh-hermes-fleet-columns>div{display:grid;align-content:start;gap:7px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-fleet-columns>div>strong{font-size:11px}.dsh-hermes-fleet-row{display:flex;align-items:flex-start;justify-content:space-between;gap:7px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-subtle,#dedbd5)}.dsh-hermes-fleet-row>div:first-child{display:grid;gap:3px;min-width:0}.dsh-hermes-fleet-row code{font-size:9px;overflow-wrap:anywhere}.dsh-hermes-fleet-row span{font-size:10px;line-height:1.4;color:var(--dsw-alias-fg-muted,#77736d);overflow-wrap:anywhere}.dsh-hermes-task-detail{display:grid;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-task-detail h4{margin:0 0 3px;font-size:13px}.dsh-hermes-task-detail small{display:block;margin-bottom:5px;font-size:10px;font-weight:650;color:var(--dsw-alias-fg-muted,#77736d)}.dsh-hermes-task-detail pre{max-height:260px;margin:0;padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.dsh-hermes-task-meta{display:flex;flex-wrap:wrap;gap:7px}.dsh-hermes-task-meta span{padding:4px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:10px}.dsh-hermes-task-run{display:grid;gap:3px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-subtle,#dedbd5)}.dsh-hermes-task-run code,.dsh-hermes-task-run span,.dsh-hermes-task-run em{font-size:10px;overflow-wrap:anywhere}.dsh-hermes-task-run em{color:#aa3939;font-style:normal}@media(max-width:720px){.dsh-hermes-fleet-columns{grid-template-columns:1fr}.dsh-hermes-fleet-profile-head{align-items:flex-start}.dsh-hermes-dynamic-bots>div:first-child{display:grid}}
.dsh-hermes-diagnostic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dsh-hermes-secondary{border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:999px;background:transparent;color:inherit;padding:7px 12px;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}.dsh-hermes-diagnostic-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.dsh-hermes-diagnostic-grid>div{display:grid;gap:5px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-diagnostic-grid span,.dsh-hermes-diagnostic-details span{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}.dsh-hermes-diagnostic-grid strong{font-size:13px}.dsh-hermes-diagnostic-empty{padding:11px;border-radius:10px;background:rgba(224,162,55,.1);font-size:11px;line-height:1.5;color:#986818}.dsh-hermes-diagnostic-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dsh-hermes-diagnostic-details>div{display:grid;gap:5px;min-width:0}.dsh-hermes-diagnostic-details strong,.dsh-hermes-diagnostic-details code{font-size:11px;overflow-wrap:anywhere}.dsh-hermes-diagnostic-details code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}@media(max-width:720px){.dsh-hermes-diagnostic-grid,.dsh-hermes-diagnostic-details{grid-template-columns:1fr 1fr}.dsh-hermes-diagnostic-head{display:grid}}
`

function installStyles(): () => void {
  const id = '@dsh-hermes-bot/client'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-hermes-bot: styles')
  const controller = new FeishuSetupController(ctx)
  ctx.effect(() => {
    const disposers = [
      ctx.on('credentials/updated', (ref) => {
        if (String(ref) === SECRET_REF) void controller.refresh()
      }),
      ctx.on('connection/reset', () => { void controller.refresh() }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  }, 'dsh-hermes-bot: settings invalidations')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-hermes-bot',
    order: 25,
    label: () => '飞书机器人',
    inject: () => ({ controller }),
  }, SettingsSection))
}
