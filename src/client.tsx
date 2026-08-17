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
  }
}

interface CredentialState {
  configured: boolean
  writable: boolean
  source?: string
}

interface SetupState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly settings?: HermesBotSettings
  readonly writable: boolean
  readonly credential: CredentialState
  readonly saving: boolean
  readonly message?: string | undefined
  readonly error?: string | undefined
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
}

function emptyCredential(): CredentialState {
  return { configured: false, writable: false }
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
      saving: false,
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
        error: undefined,
      })
    } catch (error) {
      this.publish({ status: 'unavailable', error: `读取飞书机器人设置失败：${String(error)}` })
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
    const userIds = splitIds(draft.userIds)
    const chatIds = splitIds(draft.chatIds)
    if (appId === '') {
      this.publish({ error: '请填写飞书 App ID。' })
      return
    }
    if (userIds.length === 0 && chatIds.length === 0) {
      this.publish({ error: '请至少填写一个用户 ID 或群聊 ID。' })
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
            access: { userIds, chatIds },
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
        message: '已保存，机器人正在自动启动。',
        error: undefined,
      })
    } catch (error) {
      this.publish({ error: `保存失败：${String(error)}` })
    } finally {
      this.publish({ saving: false })
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
  }
}

type SettingsProps = PropsRuntime<'settings.section'> & { controller?: FeishuSetupController }

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="dsh-hermes-field"><span>{props.label}</span>{props.children}{props.hint === undefined ? null : <small>{props.hint}</small>}</label>
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

  useEffect(() => {
    if (settings !== undefined) setDraft(draftOf(settings))
  }, [settings])

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

  return (
    <div className="dsh-hermes-settings">
      <header className="dsh-hermes-header">
        <div><span className="dsh-hermes-kicker">DeepSeek Harness 插件</span><h2>飞书机器人</h2><p>填好下面的信息，点击一次“保存并启动”即可。以后不需要再手动设置环境变量。</p></div>
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
        <p className="dsh-hermes-muted">每行一个，也可以用逗号分隔。至少填写用户 ID 或群聊 ID 中的一种。群聊里默认需要 @机器人。</p>
        <div className="dsh-hermes-grid">
          <Field label="用户 ID" hint="飞书常见格式：ou_…"><textarea rows={4} value={draft.userIds} onChange={event => { update('userIds', event.target.value) }} /></Field>
          <Field label="群聊 ID" hint="飞书常见格式：oc_…"><textarea rows={4} value={draft.chatIds} onChange={event => { update('chatIds', event.target.value) }} /></Field>
        </div>
        <label className="dsh-hermes-check"><input type="checkbox" checked={draft.requireMention} onChange={event => { update('requireMention', event.target.checked) }} /><span>群聊消息必须 @机器人</span></label>
      </section>

      <section className="dsh-hermes-panel dsh-hermes-actions">
        <label className="dsh-hermes-check"><input type="checkbox" checked={draft.enabled} onChange={event => { update('enabled', event.target.checked) }} /><span>保存后启用机器人</span></label>
        <button type="button" className="dsh-hermes-primary" disabled={!state.writable || state.saving} onClick={save}>{state.saving ? '正在保存…' : '保存并启动'}</button>
      </section>
    </div>
  )
}

const CSS = `
.dsh-hermes-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.dsh-hermes-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:8px 2px}.dsh-hermes-header h2{font-size:25px;letter-spacing:-.025em;margin:3px 0 6px}.dsh-hermes-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}.dsh-hermes-kicker{font-size:10px;letter-spacing:.1em;color:#6758d4;font-weight:700}.dsh-hermes-badge{font-size:10px;padding:4px 8px;border-radius:999px;font-weight:650;white-space:nowrap}.dsh-hermes-badge.ok{background:rgba(48,154,100,.12);color:#267d52}.dsh-hermes-badge.missing{background:rgba(205,72,72,.1);color:#aa3939}
.dsh-hermes-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}.dsh-hermes-notice{background:rgba(92,108,213,.09);color:#5149a6}.dsh-hermes-warning{background:rgba(224,162,55,.12);color:#986818}.dsh-hermes-error{background:rgba(205,72,72,.1);color:#aa3939}.dsh-hermes-success{background:rgba(48,154,100,.1);color:#267d52}.dsh-hermes-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.dsh-hermes-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}.dsh-hermes-panel h3{font-size:14px;margin:0}.dsh-hermes-muted{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:0}.dsh-hermes-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dsh-hermes-field{display:grid;gap:6px;align-content:start}.dsh-hermes-field>span{font-size:11px;font-weight:600}.dsh-hermes-field>small{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.4}.dsh-hermes-field input,.dsh-hermes-field select,.dsh-hermes-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px}.dsh-hermes-field input,.dsh-hermes-field select{height:36px}.dsh-hermes-field textarea{resize:vertical;min-height:76px}.dsh-hermes-check{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px;font-size:12px;cursor:pointer}.dsh-hermes-check input{accent-color:#6758d4}.dsh-hermes-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-hermes-primary{border:0;border-radius:999px;background:#6758d4;color:#fff;padding:9px 16px;font:inherit;font-size:12px;font-weight:650;cursor:pointer}.dsh-hermes-primary:disabled{opacity:.5;cursor:not-allowed}@media(max-width:720px){.dsh-hermes-header{display:grid}.dsh-hermes-grid{grid-template-columns:1fr}.dsh-hermes-actions{align-items:stretch;flex-direction:column}}
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
