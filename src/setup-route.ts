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
  TaskRecord,
} from './types.js'
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
    sendJson(res, 200, {
      ...snapshot,
      message: approval.status === 'approved' ? '已批准，Fleet 正在继续执行。' : approval.status === 'rejected' ? '已拒绝该 Fleet 操作。' : '该审批已过期。',
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

  if (appSecret !== '') {
    await credentials!.set(credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any, appSecret)
  }
  await settingsProvider.replace(HERMES_BOT_SETTINGS_NAMESPACE, settings)
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
