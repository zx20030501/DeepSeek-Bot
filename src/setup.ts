import z from '@deepseek-ai/schemastery'
import type { BotGatewayConfig, BotProfile } from './types.js'

/** Settings namespace shown in DeepSeek Harness Web settings. */
// Keep the namespace value as a plain string so the core package remains
// usable in headless/test installations. DSH's settings service accepts this
// stable namespace and the Web adapter can use its own helper when available.
export const HERMES_BOT_SETTINGS_NAMESPACE: any = 'dsh-hermes-bot'

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
  collaboration: {
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
      webChatBotCreation: boolean
    }
  }
  profiles: HermesBotProfileSettings[]
}

export interface HermesBotProfileSettings {
  id: string
  title: string
  description: string
  provider: string
  model: string
  capabilities: string[]
  skills: string[]
  soul: string
  fleetRole: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  sessionScope: 'requester' | 'chat' | 'shared' | 'task'
  allowedUserIds: string[]
  allowedChatIds: string[]
  approvalRequired: boolean
  enabled: boolean
}

const ProfileSettingsSchema: z<HermesBotProfileSettings> = z.object({
  id: z.string().default(''),
  title: z.string().default(''),
  description: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  capabilities: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  soul: z.string().default(''),
  fleetRole: z.union(['worker', 'verifier', 'synthesizer', 'generalist'] as const).default('generalist'),
  sessionScope: z.union(['requester', 'chat', 'shared', 'task'] as const).default('requester'),
  allowedUserIds: z.array(z.string()).default([]),
  allowedChatIds: z.array(z.string()).default([]),
  approvalRequired: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

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
  collaboration: z.object({
    enabled: z.boolean().default(true),
    autoPlanner: z.boolean().default(true),
    approvalMode: z.union(['never', 'auto-planned', 'multi-bot', 'always'] as const).default('auto-planned'),
    defaultSessionScope: z.union(['requester', 'chat', 'shared', 'task'] as const).default('requester'),
    maxGroupBots: z.number().default(6),
    maxGroupRounds: z.number().default(3),
    maxGroupMessages: z.number().default(10),
    maxParallelRuns: z.number().default(6),
    botRunMaxAttempts: z.number().default(3),
    features: z.object({
      dynamicRegistry: z.boolean().default(false),
      chatBotCreation: z.boolean().default(false),
      webChatBotCreation: z.boolean().default(false),
    }).default({ dynamicRegistry: false, chatBotCreation: false, webChatBotCreation: false }),
  }),
  profiles: z.array(ProfileSettingsSchema).default([]),
})

function listOf(values: readonly (string | number)[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))]
}

function textOf(value: string | undefined): string {
  return value ?? ''
}

function profileSettings(id: string, profile: Omit<BotProfile, 'name'>): HermesBotProfileSettings {
  return {
    id,
    title: textOf(profile.title),
    description: textOf(profile.description),
    provider: textOf(profile.provider),
    model: textOf(profile.model),
    capabilities: listOf(profile.capabilities),
    skills: listOf(profile.skills),
    soul: textOf(profile.soul),
    fleetRole: profile.fleetRole ?? 'generalist',
    sessionScope: profile.sessionScope ?? 'requester',
    allowedUserIds: listOf(profile.allowedUserIds),
    allowedChatIds: listOf(profile.allowedChatIds),
    approvalRequired: profile.approvalRequired === true,
    enabled: profile.enabled !== false,
  }
}

/** Project legacy/plugin entry config into settings form defaults. */
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
    collaboration: {
      enabled: config.collaboration?.enabled !== false,
      autoPlanner: config.collaboration?.autoPlanner !== false,
      approvalMode: config.collaboration?.approvalMode ?? 'auto-planned',
      defaultSessionScope: config.collaboration?.defaultSessionScope ?? 'requester',
      maxGroupBots: config.collaboration?.maxGroupBots ?? 6,
      maxGroupRounds: config.collaboration?.maxGroupRounds ?? config.collaboration?.maxGroupTurns ?? 3,
      maxGroupMessages: config.collaboration?.maxGroupMessages ?? 10,
      maxParallelRuns: config.collaboration?.maxParallelRuns ?? 6,
      botRunMaxAttempts: config.collaboration?.botRunMaxAttempts ?? 3,
      features: {
        dynamicRegistry: config.collaboration?.features?.dynamicRegistry === true,
        chatBotCreation: config.collaboration?.features?.dynamicRegistry === true
          && config.collaboration?.features?.chatBotCreation === true,
        webChatBotCreation: config.collaboration?.features?.dynamicRegistry === true
          && config.collaboration?.features?.webChatBotCreation === true,
      },
    },
    profiles: Object.entries(config.profiles ?? {}).map(([id, profile]) => profileSettings(id, profile)),
  }
}

/** Combine form values with non-form gateway options and an optional secret. */
export function gatewayConfigFromSettings(
  base: BotGatewayConfig,
  settings: HermesBotSettings,
  appSecret?: string,
): BotGatewayConfig {
  // Saved settings from pre-Fleet versions do not contain these sections.
  const projected = settingsFromGatewayConfig(base)
  const collaboration = settings.collaboration ?? projected.collaboration
  const collaborationFeatures = collaboration.features ?? projected.collaboration.features
  const profileRows = settings.profiles ?? projected.profiles
  const profiles: Record<string, Omit<BotProfile, 'name'>> = {}
  for (const profile of profileRows) {
    const id = profile.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id) || profiles[id] !== undefined) continue
    const baseProfile = base.profiles?.[id] ?? {}
    profiles[id] = {
      ...baseProfile,
      title: profile.title.trim() || id,
      ...(profile.description.trim() === '' ? {} : { description: profile.description.trim() }),
      ...(profile.provider.trim() === '' ? {} : { provider: profile.provider.trim() }),
      ...(profile.model.trim() === '' ? {} : { model: profile.model.trim() }),
      capabilities: listOf(profile.capabilities),
      skills: listOf(profile.skills),
      ...(profile.soul.trim() === '' ? {} : { soul: profile.soul.trim() }),
      fleetRole: profile.fleetRole,
      sessionScope: profile.sessionScope,
      allowedUserIds: listOf(profile.allowedUserIds),
      allowedChatIds: listOf(profile.allowedChatIds),
      approvalRequired: profile.approvalRequired,
      enabled: profile.enabled,
    }
  }
  return {
    ...base,
    enabled: settings.enabled,
    profiles,
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
    collaboration: {
      ...base.collaboration,
      enabled: collaboration.enabled,
      autoPlanner: collaboration.autoPlanner,
      approvalMode: collaboration.approvalMode,
      defaultSessionScope: collaboration.defaultSessionScope,
      maxGroupBots: Math.max(2, Math.min(6, Math.floor(collaboration.maxGroupBots))),
      maxGroupRounds: Math.max(1, Math.min(3, Math.floor(collaboration.maxGroupRounds))),
      maxGroupMessages: Math.max(2, Math.min(100, Math.floor(collaboration.maxGroupMessages))),
      maxParallelRuns: Math.max(1, Math.min(6, Math.floor(collaboration.maxParallelRuns))),
      botRunMaxAttempts: Math.max(1, Math.min(10, Math.floor(collaboration.botRunMaxAttempts))),
      features: {
        ...base.collaboration?.features,
        dynamicRegistry: collaborationFeatures.dynamicRegistry,
        chatBotCreation: collaborationFeatures.dynamicRegistry && collaborationFeatures.chatBotCreation,
        webChatBotCreation: collaborationFeatures.dynamicRegistry && collaborationFeatures.webChatBotCreation,
      },
    },
  }
}

/** Convert comma/newline-separated IDs from the form into stable entries. */
export function parseIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,，、;；\r\n]+/u).map(item => item.trim()).filter(Boolean))]
}
