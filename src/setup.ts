import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { BotGatewayConfig } from './types.js'

/** Settings namespace shown in DeepSeek Harness Web settings. */
export const HERMES_BOT_SETTINGS_NAMESPACE = settingsNamespace('dsh-hermes-bot')

/** The secret is stored through DSH credentials, never in settings or Git. */
export const HERMES_BOT_FEISHU_SECRET_REF = 'DSH_HERMES_BOT_FEISHU_APP_SECRET'

export interface HermesBotSettings {
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

/** Schema for the small, user-facing Feishu setup form. */
export const HermesBotSettingsSchema: z<HermesBotSettings> = z.object({
  enabled: z.boolean().default(true),
  feishu: z.object({
    enabled: z.boolean().default(true),
    appId: z.string().default(''),
    domain: z.union(['feishu', 'lark'] as const).default('feishu'),
    requireMention: z.boolean().default(true),
  }),
  access: z.object({
    userIds: z.array(z.string()).default([]),
    chatIds: z.array(z.string()).default([]),
    pairing: z.boolean().default(true),
  }),
})

function listOf(values: readonly (string | number)[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))]
}

/** Project the legacy/plugin entry config into the settings form defaults. */
export function settingsFromGatewayConfig(config: BotGatewayConfig): HermesBotSettings {
  return {
    enabled: config.enabled !== false,
    feishu: {
      enabled: config.feishu?.enabled !== false,
      appId: config.feishu?.appId ?? '',
      domain: config.feishu?.domain === 'lark' ? 'lark' : 'feishu',
      requireMention: config.feishu?.requireMention !== false,
    },
    access: {
      userIds: listOf(config.access?.userIds),
      chatIds: listOf(config.access?.chatIds),
      pairing: config.access?.pairing !== false,
    },
  }
}

/** Combine the form with the non-form gateway options and an optional secret. */
export function gatewayConfigFromSettings(
  base: BotGatewayConfig,
  settings: HermesBotSettings,
  appSecret?: string,
): BotGatewayConfig {
  return {
    ...base,
    enabled: settings.enabled,
    access: {
      ...base.access,
      mode: 'allowlist',
      userIds: settings.access.userIds,
      chatIds: settings.access.chatIds,
      pairing: settings.access.pairing !== false,
    },
    feishu: {
      ...base.feishu,
      enabled: settings.feishu.enabled,
      appId: settings.feishu.appId,
      domain: settings.feishu.domain,
      requireMention: settings.feishu.requireMention,
      ...(appSecret === undefined ? {} : { appSecret }),
    },
  }
}

/** Convert comma/newline-separated IDs from the form into stable allowlist entries. */
export function parseIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,，、;；\r\n]+/u).map(item => item.trim()).filter(Boolean))]
}
