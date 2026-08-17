import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
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

class SetupRequestError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message)
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  if (isIP(value) === 4) return value.startsWith('127.')
  return false
}

/** Keep this route subject to the same host/origin fence as DSH settings writes. */
function isTrustedLocalRequest(req: IncomingMessage): boolean {
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length === 0) return false
  let host: URL
  try {
    host = new URL(`http://${authority}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(host.hostname)) return false

  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return origin !== 'null' && new URL(origin).host === host.host
  } catch {
    return false
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
  diagnostics: () => Record<string, unknown>,
): Promise<SetupRouteSnapshot> {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const info = credentials === undefined
    ? { configured: false, writable: false }
    : await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF))
  return {
    settings: source(),
    writable: settings?.writable === true,
    credential: {
      configured: info.configured,
      writable: info.writable,
      ...(info.source === undefined ? {} : { source: info.source }),
    },
    diagnostics: diagnostics(),
  }
}

async function handleRequest(
  ctx: Context,
  source: () => HermesBotSettings,
  diagnostics: () => Record<string, unknown>,
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
  let settings: HermesBotSettings
  try {
    settings = HermesBotSettingsSchema(body.settings as HermesBotSettings)
  } catch (error) {
    throw new SetupRequestError(400, `设置格式不正确：${String(error)}`)
  }
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : ''
  if (settings.feishu.appId.trim() === '') {
    throw new SetupRequestError(400, '请填写飞书 App ID。')
  }
  if (normalizedIds(settings.access.userIds).length === 0 && normalizedIds(settings.access.chatIds).length === 0) {
    throw new SetupRequestError(400, '请至少填写一个用户 ID 或群聊 ID。')
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
    const info = await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF))
    if (!info.writable) throw new SetupRequestError(409, '当前飞书密钥来自只读环境变量，不能在网页中覆盖。')
  } else if (credentials !== undefined) {
    const info = await credentials.describe(credentialRef(HERMES_BOT_FEISHU_SECRET_REF))
    if (!info.configured) throw new SetupRequestError(400, '请填写飞书 App Secret。')
  } else {
    throw new SetupRequestError(503, 'DSH 凭据服务不可用。')
  }

  if (appSecret !== '') {
    await credentials!.set(credentialRef(HERMES_BOT_FEISHU_SECRET_REF), appSecret)
  }
  await settingsProvider.replace(HERMES_BOT_SETTINGS_NAMESPACE, settings)
  sendJson(res, 200, await readSnapshot(ctx, source, diagnostics))
}

/** Mount the plugin-owned setup route when DSH is running its Web surface. */
export function installSetupRoute(
  ctx: Context,
  source: () => HermesBotSettings,
  diagnostics: () => Record<string, unknown> = () => ({}),
): void {
  ctx.inject(['webServer'], (webCtx) => {
    const route: WebRoute = {
      kind: 'exact',
      path: HERMES_BOT_SETUP_ROUTE,
      handler: (req, res) => {
        void handleRequest(ctx, source, diagnostics, req, res).catch(error => {
          if (error instanceof SetupRequestError) {
            sendJson(res, error.status, { error: error.message })
            return
          }
          webCtx.logger.error(error instanceof Error ? error : new Error(String(error)))
          sendJson(res, 500, { error: '保存飞书机器人设置时发生内部错误。' })
        })
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'dsh-hermes-bot: setup route')
  })
}
