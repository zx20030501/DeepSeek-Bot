import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { BotGateway } from './gateway.js'
import { normalizeConfig } from './gateway.js'
import {
  gatewayConfigFromSettings,
  HERMES_BOT_FEISHU_SECRET_REF,
  HERMES_BOT_SETTINGS_NAMESPACE,
  HermesBotSettingsSchema,
  settingsFromGatewayConfig,
} from './setup.js'
import { installSetupRoute } from './setup-route.js'

export const name = 'dsh-hermes-bot'

// The plugin deliberately depends only on the public Agent seam. The session
// event stream is available in a normal DSH Agent composition and does not
// require us to fork or patch the official Agent Loop.
export const inject = ['agents']

export function apply(ctx: Context, config: unknown = {}): void {
  const baseConfig = normalizeConfig(config)
  let settingsSource = () => settingsFromGatewayConfig(baseConfig)
  const gateway = new BotGateway(ctx, baseConfig)

  const logger = (ctx as unknown as { logger?: { error?: (message: string) => void } }).logger
  let refreshTail = Promise.resolve()
  const refreshGateway = (): void => {
    refreshTail = refreshTail.then(async () => {
      const credentials = ctx.get('credentials')
      const secret = credentials === undefined
        ? undefined
        : (await credentials.resolve(credentialRef(HERMES_BOT_FEISHU_SECRET_REF)))?.value
      await gateway.reconfigure(gatewayConfigFromSettings(baseConfig, settingsSource(), secret))
    }).catch(error => {
      logger?.error?.(`[dsh-hermes-bot] settings apply failed: ${String(error)}`)
    })
  }

  installSettingsSection(
    ctx,
    HERMES_BOT_SETTINGS_NAMESPACE,
    HermesBotSettingsSchema,
    settingsFromGatewayConfig(baseConfig),
    {
      setSource: source => { settingsSource = source },
      onChange: () => { refreshGateway() },
    },
  )
  installSetupRoute(ctx, () => settingsSource(), () => gateway.status(), {
    beginDiscovery: () => gateway.beginDiscovery(),
    discoveryCandidate: () => gateway.discoveryCandidate(),
    clearDiscovery: () => gateway.clearDiscovery(),
    approvePairing: code => gateway.approvePairing(code),
    revokePairing: (platform, userId) => gateway.revokePairing(platform, userId),
  })
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.on('credentials/updated', (ref) => {
      if (String(ref) === HERMES_BOT_FEISHU_SECRET_REF) refreshGateway()
    })
    // The settings scope can attach before the credential service finishes
    // becoming available. Re-apply once here so a saved App Secret also
    // starts the transport after a DSH restart, not only after a form save.
    refreshGateway()
  })

  ctx.on('session/event', (session, event) => gateway.onSessionEvent(session, event))
  ctx.effect(() => {
    void gateway.start().catch(error => {
      logger?.error?.(`[dsh-hermes-bot] startup failed: ${String(error)}`)
    })
    return () => gateway.stop()
  }, 'dsh-hermes-bot.lifecycle()')
}

export { BotGateway, discoveryCandidateFor } from './gateway.js'
export { InboundWal, Outbox } from './durable.js'
export { PairingStore } from './pairing.js'
export { parseBotCommand, splitText } from './commands.js'
export { TelegramTransport } from './telegram.js'
export { FeishuTransport, toFeishuInbound } from './feishu.js'
export {
  gatewayConfigFromSettings,
  HERMES_BOT_FEISHU_SECRET_REF,
  HERMES_BOT_SETTINGS_NAMESPACE,
  HermesBotSettingsSchema,
  parseIdList,
  settingsFromGatewayConfig,
} from './setup.js'
export type * from './types.js'
export type { HermesBotSettings } from './setup.js'
