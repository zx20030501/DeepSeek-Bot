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
  userIds: string
  chatIds: string
  pairingEnabled: boolean
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

function draftOf(settings: HermesBotSettings): Draft {
  return {
    enabled: settings.enabled,
    feishuEnabled: settings.feishu.enabled,
    appId: settings.feishu.appId,
    appSecret: '',
    domain: settings.feishu.domain,
    requireMention: settings.feishu.requireMention,
    userIds: settings.access.userIds.join('\n'),
    chatIds: settings.access.chatIds.join('\n'),
    pairingEnabled: settings.access.pairing !== false,
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
    const userIds = splitIds(draft.userIds)
    if (userIds.length === 0 && discoveredUserId !== undefined) userIds.push(discoveredUserId)
    const chatIds = splitIds(draft.chatIds)
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
          },
          ...(draft.appSecret.trim() === '' ? {} : { appSecret: draft.appSecret.trim() }),
        }),
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
          },
          ...(draft.appSecret.trim() === '' ? {} : { appSecret: draft.appSecret.trim() }),
        }),
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

  public async revokePairing(platform: string, userId: string): Promise<void> {
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
    } catch (error) {
      this.publish({ error: `取消配对失败：${String(error)}` })
    } finally {
      this.publish({ pairingApproving: false })
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
      if (current === undefined || splitIds(current.userIds).length > 0) return current
      return { ...current, userIds: discoveredUserId }
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
  const approvePairing = (): void => {
    void controller.approvePairing(pairingCode).then(candidate => {
      if (candidate?.userId !== undefined) update('userIds', candidate.userId)
      if (candidate !== undefined) setPairingCode('')
    })
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
        <p className="dsh-hermes-muted">每行一个，也可以用逗号分隔。可以直接填写用户/群聊 ID，也可以开启安全配对，让陌生用户先拿配对码。群聊里默认需要 @机器人。</p>
        <div className="dsh-hermes-grid">
          <Field label="用户 ID" hint="推荐点击下方“一键测试并自动识别 UID”，不需要手动查 ou_…"><textarea rows={4} value={draft.userIds} onChange={event => { update('userIds', event.target.value) }} /></Field>
          <Field label="群聊 ID" hint="飞书常见格式：oc_…"><textarea rows={4} value={draft.chatIds} onChange={event => { update('chatIds', event.target.value) }} /></Field>
        </div>
        <div className="dsh-hermes-action-row">
          <button type="button" className="dsh-hermes-secondary" disabled={!state.writable || state.saving || state.diagnosing} onClick={() => { void controller.startDiscovery(draft) }}>{state.diagnosing ? '正在测试连接…' : '一键测试并自动识别 UID'}</button>
          {state.diagnostics.discovery?.candidate?.userId === undefined ? null : <button type="button" className="dsh-hermes-secondary" onClick={() => { update('userIds', state.diagnostics.discovery?.candidate?.userId ?? '') }}>再次填入检测到的 UID</button>}
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
        <p className="dsh-hermes-muted">当前待确认配对：{String(state.diagnostics.pairing?.pending?.length ?? 0)} 个。配对成功后，对方可以立即使用；点击“保存并启动”还会把 UID 同步到白名单文本框。</p>
        {(state.diagnostics.pairing?.approved?.length ?? 0) === 0 ? null : <div className="dsh-hermes-pairing-approved"><span className="dsh-hermes-muted">已确认的配对用户</span>{state.diagnostics.pairing?.approved?.map(item => item.userId === undefined ? null : <div className="dsh-hermes-pairing-approved-row" key={`${item.platform ?? 'unknown'}:${item.userId}`}><code>{item.userId}</code><button type="button" className="dsh-hermes-secondary" disabled={state.pairingApproving} onClick={() => { void controller.revokePairing(item.platform ?? 'feishu', item.userId ?? '') }}>取消配对</button></div>)}</div>}
      </section>

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
.dsh-hermes-action-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-hermes-action-row .dsh-hermes-muted{flex:1 1 260px}.dsh-hermes-pairing-input{height:36px;min-width:220px;flex:1 1 240px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px;text-transform:uppercase}.dsh-hermes-pairing-approved{display:grid;gap:7px}.dsh-hermes-pairing-approved-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}.dsh-hermes-pairing-approved-row code{font-size:11px;overflow-wrap:anywhere}
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
