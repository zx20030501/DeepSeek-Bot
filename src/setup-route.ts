import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { HERMES_BOT_SETUP_ROUTE } from './setup-constants.js'
import {
  HERMES_BOT_FEISHU_SECRET_REF,
  HERMES_BOT_SETTINGS_NAMESPACE,
  HermesBotSettingsSchema,
  type HermesBotSettings,
} from './setup.js'
import type {
  FleetApprovalRecord,
  FleetReplayResult,
  FleetTaskDetail,
  GatewayDiscoveryCandidate,
  GatewayDiscoveryStatus,
  BotRegistryEntry,
  TaskRecord,
  TeamDefinition,
} from './types.js'
import type { BotCreateDraftToolInput, BotCreateDraftToolResult } from './bot-registry-tool.js'
import { isTrustedLocalRequest } from './setup-security.js'

const MAX_BODY_BYTES = 64 * 1024

interface SetupRouteSnapshot {
  settings: HermesBotSettings
  writable: boolean
  credential: {
    configured: boolean
    writable: boolean
    source?: string
  }
  diagnostics: Record<string, unknown>
}

export interface SetupRouteActions {
  beginDiscovery?: () => GatewayDiscoveryStatus
  discoveryCandidate?: () => GatewayDiscoveryCandidate | undefined
  clearDiscovery?: () => void
  approvePairing?: (code: string) => Promise<GatewayDiscoveryCandidate | undefined>
  revokePairing?: (platform: string, userId: string) => Promise<boolean>
  resolveFleetApproval?: (code: string, decision: 'approved' | 'rejected') => Promise<FleetApprovalRecord | undefined>
  fleetTaskDetail?: (taskId: string) => Promise<FleetTaskDetail | undefined>
  cancelFleetTask?: (taskId: string) => Promise<TaskRecord | undefined>
  replayFleetTask?: (taskId: string) => Promise<FleetReplayResult | undefined>
  setDynamicBotStatus?: (botId: string, status: 'active' | 'disabled' | 'deleted') => Promise<BotRegistryEntry | undefined>
  validateStaticProfiles?: (handles: readonly string[]) => Promise<void>
  registerLocalWebOwnerSession?: (sessionId: string) => Promise<void>
  saveAndApplySettings?: (settings: HermesBotSettings, appSecret?: string) => Promise<void>
  createWebDashboardBotDraft?: (input: BotCreateDraftToolInput) => Promise<BotCreateDraftToolResult>
  createWebDashboardTeam?: (name: string, memberBotIds: readonly string[]) => Promise<TeamDefinition>
  dispatchOwnerWebCommand?: (sessionId: string, text: string) => Promise<void>
}

class SetupRequestError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new SetupRequestError(413, '请求内容太大。')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new SetupRequestError(413, '请求内容太大。')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SetupRequestError(400, '请求不是有效的 JSON。')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SetupRequestError(400, '请求格式不正确。')
  }
  return value as Record<string, unknown>
}

function normalizedIds(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function mergeFleetSettings(current: HermesBotSettings, body: Record<string, unknown>): HermesBotSettings {
  const collaborationRaw = body.collaboration
  const profilesRaw = body.profiles
  const collaboration = typeof collaborationRaw === 'object' && collaborationRaw !== null && !Array.isArray(collaborationRaw)
    ? collaborationRaw as Record<string, unknown>
    : undefined
  const featuresRaw = collaboration?.features
  const features = typeof featuresRaw === 'object' && featuresRaw !== null && !Array.isArray(featuresRaw)
    ? featuresRaw as Record<string, unknown>
    : undefined
  const nextCollaboration = {
    ...current.collaboration,
    ...(collaboration?.enabled === undefined ? {} : { enabled: collaboration.enabled === true }),
    ...(collaboration?.autoPlanner === undefined ? {} : { autoPlanner: collaboration.autoPlanner === true }),
    ...(typeof collaboration?.approvalMode === 'string' ? { approvalMode: collaboration.approvalMode as HermesBotSettings['collaboration']['approvalMode'] } : {}),
    ...(typeof collaboration?.defaultSessionScope === 'string'
      ? { defaultSessionScope: collaboration.defaultSessionScope as HermesBotSettings['collaboration']['defaultSessionScope'] }
      : {}),
    ...(typeof collaboration?.maxGroupBots === 'number' ? { maxGroupBots: collaboration.maxGroupBots } : {}),
    ...(typeof collaboration?.maxGroupRounds === 'number' ? { maxGroupRounds: collaboration.maxGroupRounds } : {}),
    ...(typeof collaboration?.maxGroupMessages === 'number' ? { maxGroupMessages: collaboration.maxGroupMessages } : {}),
    ...(typeof collaboration?.maxParallelRuns === 'number' ? { maxParallelRuns: collaboration.maxParallelRuns } : {}),
    ...(typeof collaboration?.botRunMaxAttempts === 'number' ? { botRunMaxAttempts: collaboration.botRunMaxAttempts } : {}),
    features: {
      ...current.collaboration.features,
      ...(features?.dynamicRegistry === undefined ? {} : { dynamicRegistry: features.dynamicRegistry === true }),
      ...(features?.chatBotCreation === undefined ? {} : { chatBotCreation: features.chatBotCreation === true }),
      ...(features?.webChatBotCreation === undefined ? {} : { webChatBotCreation: features.webChatBotCreation === true }),
      ...(features?.peerMessaging === undefined ? {} : { peerMessaging: features.peerMessaging === true }),
      ...(features?.managerAgent === undefined ? {} : { managerAgent: features.managerAgent === true }),
      ...(features?.savedWorkflows === undefined ? {} : { savedWorkflows: features.savedWorkflows === true }),
      ...(features?.externalRuntimes === undefined ? {} : { externalRuntimes: features.externalRuntimes === true }),
      ...(features?.routines === undefined ? {} : { routines: features.routines === true }),
    },
  }
  if (body.enableFleet === true) {
    nextCollaboration.enabled = true
    nextCollaboration.features.webChatBotCreation = true
  }
  let profiles = current.profiles
  if (Array.isArray(profilesRaw)) {
    profiles = HermesBotSettingsSchema({ ...current, profiles: profilesRaw }).profiles
  }
  return HermesBotSettingsSchema({
    ...current,
    collaboration: nextCollaboration,
    profiles,
  })
}

function botDraftInputFromBody(body: Record<string, unknown>): BotCreateDraftToolInput {
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (handle === '' || title === '') throw new SetupRequestError(400, 'Bot handle 和名称不能为空。')
  const capabilities = typeof body.capabilities === 'string'
    ? body.capabilities.split(/[\s,，、;；\r\n]+/u).map(item => item.trim()).filter(Boolean)
    : Array.isArray(body.capabilities)
      ? body.capabilities.map(item => String(item).trim()).filter(Boolean)
      : []
  const skills = typeof body.skills === 'string'
    ? body.skills.split(/[\s,，、;；\r\n]+/u).map(item => item.trim()).filter(Boolean)
    : Array.isArray(body.skills)
      ? body.skills.map(item => String(item).trim()).filter(Boolean)
      : []
  const roleRaw = typeof body.fleetRole === 'string' ? body.fleetRole.trim() : 'generalist'
  let role: 'worker' | 'verifier' | 'synthesizer' | 'generalist' = 'generalist'
  if (roleRaw === 'worker' || roleRaw === 'verifier' || roleRaw === 'synthesizer' || roleRaw === 'generalist') {
    role = roleRaw
  }
  return {
    handle,
    title,
    ...(typeof body.description === 'string' && body.description.trim() !== '' ? { description: body.description.trim() } : {}),
    ...(typeof body.model === 'string' && body.model.trim() !== '' ? { model: body.model.trim() } : {}),
    ...(typeof body.soul === 'string' && body.soul.trim() !== '' ? { soul: body.soul.trim() } : {}),
    capabilities,
    skills,
    role,
  }
}

async function readSnapshot(
  ctx: Context,
  source: () => HermesBotSettings,
  diagnostics: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<SetupRouteSnapshot> {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const info = credentials === undefined
    ? { configured: false, writable: false }
    : await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any)
  return {
    settings: source(),
    writable: settings?.writable === true,
    credential: {
      configured: info.configured,
      writable: info.writable,
      ...(info.source === undefined ? {} : { source: info.source }),
    },
    diagnostics: await diagnostics(),
  }
}

async function handleRequest(
  ctx: Context,
  source: () => HermesBotSettings,
  diagnostics: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  actions: SetupRouteActions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedLocalRequest(req)) {
    sendJson(res, 403, { error: '此设置接口只接受本机请求。' })
    return
  }

  if (req.method === 'GET') {
    sendJson(res, 200, await readSnapshot(ctx, source, diagnostics))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }

  const body = await readJson(req)
  const action = body.action === undefined ? 'save' : body.action
  if (
    action !== 'save'
    && action !== 'diagnose'
    && action !== 'pairing_approve'
    && action !== 'pairing_revoke'
    && action !== 'fleet_approval_resolve'
    && action !== 'fleet_task_detail'
    && action !== 'fleet_task_cancel'
    && action !== 'fleet_task_replay'
    && action !== 'bot_registry_status'
    && action !== 'register_owner_web_session'
    && action !== 'save_fleet_config'
    && action !== 'bot_create_draft'
    && action !== 'owner_web_command'
    && action !== 'team_create'
  ) {
    throw new SetupRequestError(400, '不认识的设置操作。')
  }
  if (action === 'pairing_approve') {
    const code = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : ''
    if (code === '') throw new SetupRequestError(400, '请输入配对码。')
    if (actions.approvePairing === undefined) throw new SetupRequestError(503, '配对服务还没有准备好，请稍后再试。')
    const candidate = await actions.approvePairing(code)
    if (candidate === undefined) throw new SetupRequestError(404, '配对码不存在、已使用或已过期。请让用户重新给机器人发一条私聊消息。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, {
      ...snapshot,
      pairingCandidate: candidate,
      message: '配对成功。该用户会收到提示，请在飞书同一个聊天中发送 /new 开始新的会话；UID 已追加到用户 ID 列表，点击“保存并启动”即可长期保存。',
    })
    return
  }
  if (action === 'pairing_revoke') {
    const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    if (platform === '' || userId === '') throw new SetupRequestError(400, '缺少要取消配对的用户信息。')
    if (actions.revokePairing === undefined) throw new SetupRequestError(503, '配对服务还没有准备好，请稍后再试。')
    const removed = await actions.revokePairing(platform, userId)
    if (!removed) throw new SetupRequestError(404, '没有找到这条已确认的配对记录。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, { ...snapshot, message: '已取消该用户的配对权限。' })
    return
  }
  if (action === 'fleet_approval_resolve') {
    const code = typeof body.approvalCode === 'string' ? body.approvalCode.trim() : ''
    const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : undefined
    if (code === '' || decision === undefined) throw new SetupRequestError(400, '缺少审批码或审批决定。')
    if (actions.resolveFleetApproval === undefined) throw new SetupRequestError(503, 'Fleet 审批服务还没有准备好。')
    const approval = await actions.resolveFleetApproval(code, decision)
    if (approval === undefined) throw new SetupRequestError(404, '审批不存在、已处理或已过期。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    const fleet = snapshot.diagnostics.fleet as { registryBots?: Array<{ id?: string; status?: string; runtimeReady?: boolean }> } | undefined
    const activationTarget = approval.kind === 'bot-activation'
      ? fleet?.registryBots?.find(bot => bot.id === approval.entityId)
      : undefined
    const activationApplied = activationTarget?.status === 'active' && activationTarget.runtimeReady === true
    sendJson(res, 200, {
      ...snapshot,
      message: approval.kind === 'bot-activation'
        ? approval.status === 'approved'
          ? activationApplied ? '已确认并激活动态 Bot。' : '该批准对应的草稿版本已变化，因此没有激活。请刷新后确认新的 8 位码。'
          : approval.status === 'rejected' ? '已拒绝激活；Bot 仍保留为草稿。' : '该 Bot 激活码已过期。'
        : approval.status === 'approved' ? '已批准，Fleet 正在继续执行。' : approval.status === 'rejected' ? '已拒绝该 Fleet 操作。' : '该审批已过期。',
    })
    return
  }
  if (action === 'fleet_task_detail') {
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (taskId === '') throw new SetupRequestError(400, '缺少任务 ID。')
    if (actions.fleetTaskDetail === undefined) throw new SetupRequestError(503, 'Fleet 任务服务还没有准备好。')
    const taskDetail = await actions.fleetTaskDetail(taskId)
    if (taskDetail === undefined) throw new SetupRequestError(404, '没有找到这个任务。')
    sendJson(res, 200, { taskDetail })
    return
  }
  if (action === 'fleet_task_cancel') {
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (taskId === '') throw new SetupRequestError(400, '缺少任务 ID。')
    if (actions.cancelFleetTask === undefined) throw new SetupRequestError(503, 'Fleet 任务服务还没有准备好。')
    const task = await actions.cancelFleetTask(taskId)
    if (task === undefined) throw new SetupRequestError(409, '任务不存在或已经结束，无法取消。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, { ...snapshot, message: `已取消任务 ${task.id}，并停止关联的待处理或运行中 Bot。` })
    return
  }
  if (action === 'fleet_task_replay') {
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (taskId === '') throw new SetupRequestError(400, '缺少任务 ID。')
    if (actions.replayFleetTask === undefined) throw new SetupRequestError(503, 'Fleet 任务服务还没有准备好。')
    const replay = await actions.replayFleetTask(taskId)
    if (replay === undefined) throw new SetupRequestError(409, '任务不存在、仍在运行，或者原 Bot 已不可用，无法重放。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, {
      ...snapshot,
      replay,
      message: `已创建新的重放任务 ${replay.taskId}；旧任务和历史记录保持不变。`,
    })
    return
  }
  if (action === 'bot_registry_status') {
    const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
    const status = body.status === 'active' || body.status === 'disabled' || body.status === 'deleted' ? body.status : undefined
    if (botId === '' || status === undefined) throw new SetupRequestError(400, '缺少动态 Bot ID 或目标状态。')
    if (actions.setDynamicBotStatus === undefined) throw new SetupRequestError(503, '动态 Bot 管理服务还没有准备好。')
    let bot: BotRegistryEntry | undefined
    try {
      bot = await actions.setDynamicBotStatus(botId, status)
    } catch (error: unknown) {
      throw new SetupRequestError(409, error instanceof Error ? error.message : String(error))
    }
    if (bot === undefined) throw new SetupRequestError(404, '没有找到这个动态 Bot。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    const verb = status === 'active' ? '启用' : status === 'disabled' ? '停用' : '删除'
    sendJson(res, 200, { ...snapshot, message: `已${verb} @${bot.definition.handle}。` })
    return
  }
  if (action === 'register_owner_web_session') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') throw new SetupRequestError(400, '缺少 DSH Web 会话 ID。')
    if (actions.registerLocalWebOwnerSession === undefined) {
      throw new SetupRequestError(503, 'DSH Web 会话注册服务还没有准备好。')
    }
    await actions.registerLocalWebOwnerSession(sessionId)
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, { ...snapshot, message: '已为本机 DSH Web 对话会话安装 Bot 创建工具。' })
    return
  }
  if (action === 'save_fleet_config') {
    if (actions.saveAndApplySettings === undefined) throw new SetupRequestError(503, '设置事务服务还没有准备好，请稍后再试。')
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    const merged = mergeFleetSettings(snapshot.settings, body)
    await actions.saveAndApplySettings(merged)
    const next = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, {
      ...next,
      message: 'Fleet 设置已保存并启用；右栏 BOTS 与 Web Bot 创建现已可用。',
    })
    return
  }
  if (action === 'bot_create_draft') {
    if (actions.createWebDashboardBotDraft === undefined) {
      throw new SetupRequestError(503, 'Web Bot 创建服务还没有准备好。')
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId !== '' && actions.registerLocalWebOwnerSession !== undefined) {
      await actions.registerLocalWebOwnerSession(sessionId)
    }
    const draft = await actions.createWebDashboardBotDraft(botDraftInputFromBody(body))
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, { ...snapshot, draft, message: draft.message })
    return
  }
  if (action === 'owner_web_command') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (sessionId === '' || text === '') throw new SetupRequestError(400, '缺少 sessionId 或命令文本。')
    if (actions.dispatchOwnerWebCommand === undefined) {
      throw new SetupRequestError(503, 'DSH Web 命令注入服务还没有准备好。')
    }
    await actions.dispatchOwnerWebCommand(sessionId, text)
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, { ...snapshot, message: '已向当前 DSH Web 会话注入命令。' })
    return
  }
  if (action === 'team_create') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const members = typeof body.memberBotIds === 'string'
      ? body.memberBotIds.split(/[\s,，、;；\r\n]+/u).map(item => item.trim().toLowerCase()).filter(Boolean)
      : Array.isArray(body.memberBotIds)
        ? body.memberBotIds.map(item => String(item).trim().toLowerCase()).filter(Boolean)
        : []
    if (name === '' || members.length === 0) throw new SetupRequestError(400, 'Team 名称和成员不能为空。')
    if (actions.createWebDashboardTeam === undefined) throw new SetupRequestError(503, 'Team 创建服务还没有准备好。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId !== '' && actions.registerLocalWebOwnerSession !== undefined) {
      await actions.registerLocalWebOwnerSession(sessionId)
    }
    const team = await actions.createWebDashboardTeam(name, members)
    const snapshot = await readSnapshot(ctx, source, diagnostics)
    sendJson(res, 200, {
      ...snapshot,
      team: {
        id: team.id,
        name: team.name,
        memberBotIds: [...team.memberBotIds],
        status: team.status,
      },
      message: `Team ${team.id} 已创建，可在对话中使用 @${team.id} 或 @team 协作。`,
    })
    return
  }
  let settings: HermesBotSettings
  try {
    settings = HermesBotSettingsSchema(body.settings as HermesBotSettings)
  } catch (error) {
    throw new SetupRequestError(400, `设置格式不正确：${String(error)}`)
  }
  const profileIds = new Set<string>()
  for (const profile of settings.profiles) {
    const id = profile.id.trim().toLowerCase()
    if (profile.id.trim() !== id || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)) {
      throw new SetupRequestError(400, `Bot ID 不合法：${profile.id}。只能使用小写字母、数字、下划线和短横线。`)
    }
    if (profileIds.has(id)) throw new SetupRequestError(400, `Bot ID 重复：${id}`)
    profileIds.add(id)
  }
  if (actions.validateStaticProfiles !== undefined) {
    try {
      await actions.validateStaticProfiles([...profileIds])
    } catch (error: unknown) {
      throw new SetupRequestError(409, error instanceof Error ? error.message : String(error))
    }
  }
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : ''
  if (settings.feishu.appId.trim() === '') {
    throw new SetupRequestError(400, '请填写飞书 App ID。')
  }
  const candidate = actions.discoveryCandidate?.()
  const currentUserIds = normalizedIds(settings.access.userIds)
  const currentChatIds = normalizedIds(settings.access.chatIds)
  if (action === 'save' && currentUserIds.length === 0 && currentChatIds.length === 0 && candidate?.userId !== undefined) {
    settings = {
      ...settings,
      access: { ...settings.access, userIds: [candidate.userId], chatIds: currentChatIds },
    }
  }
  if (action === 'save' && settings.access.pairing !== true && normalizedIds(settings.access.userIds).length === 0 && normalizedIds(settings.access.chatIds).length === 0) {
    throw new SetupRequestError(400, '请先点击“测试并自动识别 UID”，或填写一个用户 ID / 群聊 ID。')
  }
  if (action === 'diagnose') {
    if (actions.beginDiscovery === undefined) throw new SetupRequestError(503, '诊断服务还没有准备好，请稍后再试。')
    // Keep the temporary discovery configuration fail-closed: no ordinary
    // message can reach the Agent until the one-time command identifies a user.
    settings = { ...settings, access: { ...settings.access, userIds: [], chatIds: [] } }
  }

  const settingsProvider = ctx.get('settings')
  if (settingsProvider === undefined || settingsProvider.get(HERMES_BOT_SETTINGS_NAMESPACE) === undefined) {
    throw new SetupRequestError(503, 'DSH 设置服务还没有准备好，请稍后再试。')
  }
  if (!settingsProvider.writable) {
    throw new SetupRequestError(409, '当前 DSH 设置为只读，不能保存。')
  }

  const credentials = ctx.get('credentials')
  if (appSecret !== '') {
    if (credentials === undefined) throw new SetupRequestError(503, 'DSH 凭据服务不可用。')
    const info = await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any)
    if (!info.writable) throw new SetupRequestError(409, '当前飞书密钥来自只读环境变量，不能在网页中覆盖。')
  } else if (credentials !== undefined) {
    const info = await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any)
    if (!info.configured) throw new SetupRequestError(400, '请填写飞书 App Secret。')
  } else {
    throw new SetupRequestError(503, 'DSH 凭据服务不可用。')
  }

  try {
    if (actions.saveAndApplySettings === undefined) throw new Error('设置事务服务还没有准备好，请稍后再试。')
    await actions.saveAndApplySettings(settings, appSecret === '' ? undefined : appSecret)
  } catch {
    // Provider/runtime errors are not safe response text: an implementation may
    // include the submitted or previous credential in its Error.message.
    throw new SetupRequestError(409, '设置没有生效，也没有保留半完成配置。请检查 App ID、App Secret 和本机服务状态后重试。')
  }
  const discovery = action === 'diagnose' ? actions.beginDiscovery!() : undefined
  if (action === 'save') actions.clearDiscovery?.()
  const snapshot = await readSnapshot(ctx, source, diagnostics)
  sendJson(res, 200, {
    ...snapshot,
    ...(discovery === undefined
      ? { message: '已保存，机器人正在自动启动。请在飞书同一个聊天中发送 /new 开始新的会话，然后再正常使用。' }
      : { message: '已启动连接测试。请等待长连接显示“已连接”，再按提示给机器人发送一次性绑定口令。' }),
  })
}

/** Mount the plugin-owned setup route when DSH is running its Web surface. */
export function installSetupRoute(
  ctx: Context,
  source: () => HermesBotSettings,
  diagnostics: () => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({}),
  actions: SetupRouteActions = {},
): void {
  ctx.inject(['webServer'], (webCtx) => {
    const route: WebRoute = {
      kind: 'exact',
      path: HERMES_BOT_SETUP_ROUTE,
      handler: (req, res) => {
        void handleRequest(ctx, source, diagnostics, actions, req, res).catch(error => {
          if (error instanceof SetupRequestError) {
            sendJson(res, error.status, { error: error.message })
            return
          }
          webCtx.logger.error(error instanceof Error ? error : new Error(String(error)))
          sendJson(res, 500, { error: '保存飞书机器人设置时发生内部错误。' })
        })
      },
    }
    const webServer = (webCtx as unknown as { webServer: { register: (value: WebRoute) => unknown } }).webServer
    webCtx.effect(() => {
      const cleanup = webServer.register(route)
      return typeof cleanup === 'function' ? (cleanup as () => void) : (() => {})
    }, 'dsh-hermes-bot: setup route')
  })
}
