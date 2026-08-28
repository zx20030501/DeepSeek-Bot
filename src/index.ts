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
  type HermesBotSettings,
} from './setup.js'
import { installSetupRoute } from './setup-route.js'

export const name = 'dsh-hermes-bot'

// The plugin deliberately depends only on the public Agent seam. The session
// event stream is available in a normal DSH Agent composition and does not
// require us to fork or patch the official Agent Loop.
export const inject = ['agents']

export function apply(ctx: Context, config: unknown = {}): void {
  const baseConfig = normalizeConfig(config)
  let settingsSource: () => HermesBotSettings = () => settingsFromGatewayConfig(baseConfig)
  const gateway = new BotGateway(ctx, baseConfig)

  const logger = (ctx as unknown as { logger?: { error?: (message: string) => void } }).logger
  let refreshTail: Promise<void> = Promise.resolve()
  let refreshSuppression = 0
  let refreshRequested = false
  const runGatewayRefresh = async (): Promise<void> => {
    const credentials = ctx.get('credentials')
    const secret = credentials === undefined
      ? undefined
      : (await credentials.resolve(credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any))?.value
    await gateway.reconfigure(gatewayConfigFromSettings(baseConfig, settingsSource(), secret))
  }
  const enqueueGatewayRefresh = (): Promise<void> => {
    const run = refreshTail.catch(() => undefined).then(runGatewayRefresh)
    refreshTail = run.then(() => undefined, () => undefined)
    return run
  }
  const requestGatewayRefresh = (): void => {
    if (refreshSuppression > 0) {
      refreshRequested = true
      return
    }
    void enqueueGatewayRefresh().catch(error => {
      logger?.error?.(`[dsh-hermes-bot] settings apply failed: ${String(error)}`)
    })
  }

  let settingsCommitTail: Promise<void> = Promise.resolve()
  const saveAndApplySettings = (nextSettings: HermesBotSettings, appSecret?: string): Promise<void> => {
    const run = settingsCommitTail.catch(() => undefined).then(async () => {
      const settingsProvider = ctx.get('settings')
      const credentials = ctx.get('credentials')
      if (settingsProvider === undefined || credentials === undefined) throw new Error('DSH 设置或凭据服务不可用。')
      const secretRef = credentialRef(HERMES_BOT_FEISHU_SECRET_REF) as any
      const previousSettings = structuredClone(settingsSource())
      const previousCredential = await credentials.resolve(secretRef)
      const previousSecret = previousCredential?.value
      const nextSecret = appSecret ?? previousSecret
      const nextConfig = gatewayConfigFromSettings(baseConfig, nextSettings, nextSecret)
      let settingsWriteAttempted = false
      let secretWriteAttempted = false
      refreshSuppression += 1
      try {
        await gateway.reconfigureAndCommit(
          nextConfig,
          async () => {
            if (appSecret !== undefined && appSecret !== previousSecret) {
              secretWriteAttempted = true
              await credentials.set(secretRef, appSecret)
            }
            settingsWriteAttempted = true
            await settingsProvider.replace(HERMES_BOT_SETTINGS_NAMESPACE, nextSettings)
          },
          async () => {
            const rollbackErrors: unknown[] = []
            if (settingsWriteAttempted) {
              try {
                await settingsProvider.replace(HERMES_BOT_SETTINGS_NAMESPACE, previousSettings)
              } catch (error: unknown) {
                rollbackErrors.push(error)
              }
            }
            if (secretWriteAttempted) {
              try {
                if (previousSecret === undefined) await credentials.unset(secretRef)
                else await credentials.set(secretRef, previousSecret)
              } catch (error: unknown) {
                rollbackErrors.push(error)
              }
            }
            if (rollbackErrors.length > 0) throw new AggregateError(rollbackErrors, '持久设置回滚失败。')
          },
        )
      } catch (error: unknown) {
        // reconfigureAndCommit already restored the previous runtime and invokes
        // the durable rollback callback before releasing the namespace lane.
        throw error
      } finally {
        refreshSuppression -= 1
        if (refreshSuppression === 0 && refreshRequested) {
          refreshRequested = false
          requestGatewayRefresh()
        }
      }
    })
    settingsCommitTail = run.then(() => undefined, () => undefined)
    return run
  }

  installSettingsSection(
    ctx,
    HERMES_BOT_SETTINGS_NAMESPACE,
    HermesBotSettingsSchema,
    settingsFromGatewayConfig(baseConfig),
    {
      setSource: (source: () => HermesBotSettings) => { settingsSource = source },
      onChange: () => { requestGatewayRefresh() },
    },
  )
  installSetupRoute(ctx, () => settingsSource(), () => gateway.fleetStatus(), {
    beginDiscovery: () => gateway.beginDiscovery(),
    discoveryCandidate: () => gateway.discoveryCandidate(),
    clearDiscovery: () => gateway.clearDiscovery(),
    approvePairing: code => gateway.approvePairing(code),
    revokePairing: (platform, userId) => gateway.revokePairing(platform, userId),
    resolveFleetApproval: (code, decision) => gateway.resolveApproval(code, decision),
    fleetTaskDetail: taskId => gateway.fleetTaskDetail(taskId),
    cancelFleetTask: taskId => gateway.cancelFleetTask(taskId),
    replayFleetTask: taskId => gateway.replayFleetTask(taskId),
    setDynamicBotStatus: (botId, status) => gateway.setDynamicBotStatus(botId, status),
    validateStaticProfiles: handles => gateway.validateStaticProfileHandles(handles),
    saveAndApplySettings,
  })
  ctx.inject(['credentials'], (credentialsCtx) => {
    const credentialEvents = credentialsCtx as unknown as {
      on: (event: string, listener: (ref: unknown) => void) => unknown
    }
    credentialEvents.on('credentials/updated', (ref) => {
      if (String(ref) === HERMES_BOT_FEISHU_SECRET_REF) requestGatewayRefresh()
    })
    // The settings scope can attach before the credential service finishes
    // becoming available. Re-apply once here so a saved App Secret also
    // starts the transport after a DSH restart, not only after a form save.
    requestGatewayRefresh()
  })

  ctx.on('session/event', (session, event) => {
    gateway.tryRegisterOwnerWebSession(session, event)
    gateway.onSessionEvent(session, event)
  })
  ctx.effect(() => {
    void gateway.start().catch(error => {
      logger?.error?.(`[dsh-hermes-bot] startup failed: ${String(error)}`)
    })
    return () => gateway.stop()
  }, 'dsh-hermes-bot.lifecycle()')
}

export { BotGateway, discoveryCandidateFor } from './gateway.js'
export type { WorkflowLaunchOptions } from './gateway.js'
export { InboundWal, Outbox } from './durable.js'
export {
  BotDirectory,
  BotMailbox,
  FleetApprovalStore,
  FleetPlanner,
  GroupRoomStore,
  TaskRunStore,
  createEnvelope,
  parseBotMentions,
} from './collaboration.js'
export { PairingStore } from './pairing.js'
export {
  REMOTE_TRANSPORT_SCHEMA_VERSION,
  HttpRemoteBotTransport,
  LoopbackRemoteTransport,
  RemoteDeliveryLedger,
  RemoteTransportError,
  RemoteTransportValidationError,
  createRemoteTransportHandler,
  createRemoteTransportMessage,
  normalizeRemoteTransportPolicy,
  signRemoteTransportBody,
  validateRemoteTransportMessage,
  verifyRemoteTransportSignature,
} from './remote-transport.js'
export type {
  HttpRemoteTransportOptions,
  LoopbackRemoteTransportOptions,
  RemoteBotTransportMessage,
  RemoteBotTransportMessageInput,
  RemoteFenceDecision,
  RemoteTransportHandlerOptions,
  RemoteTransportPolicy,
  RemoteTransportPolicyInput,
  RemoteTransportReceipt,
  RemoteTransportReceiver,
} from './remote-transport.js'
export {
  PEER_MESSAGE_SCHEMA_VERSION,
  PeerMessageValidationError,
  createPeerEnvelope,
  forwardPeerMessage,
  isPeerMessage,
  normalizePeerPolicy,
  peerMessageIdempotencyKey,
  validatePeerPayload,
} from './peer-messaging.js'
export type { PeerMessageInput, PeerMessagePolicy } from './peer-messaging.js'
export {
  compileManagerDispatches,
  compileWorkflowLaunch,
  managerDescriptorsFromRoster,
  workflowDispatchKey,
  FleetRuntimeCompileError,
} from './fleet-runtime.js'
export type {
  ManagerGatewayRequest,
  ManagerRuntimeResult,
  ManagerDispatchSpec,
  WorkflowLaunchPlan,
  WorkflowNodeDispatchSpec,
} from './fleet-runtime.js'
export {
  generateManagerPlan,
  generateReplanSuggestion,
  managerPolicySummary,
} from './manager-policy.js'
export { parseFleetMentions, parseMentions } from './mention-parser.js'
export {
  assertValidWorkflow,
  assertValidWorkflowDraft,
  migrateWorkflowManifest,
  validateWorkflow,
  validateWorkflowDraft,
} from './workflow-schema.js'
export { WorkflowStore } from './workflow-store.js'
export type * from './fleet-v2-types.js'
export { BotRegistry } from './bot-registry.js'
export type { BotRegistryStats } from './bot-registry.js'
export { TeamStore } from './team-store.js'
export { TeamRouter, teamMentionHandle } from './team-router.js'
export type { TeamRoutePlan, TeamRouteRequest } from './team-router.js'
export type {
  CreateAgentThreadInput,
  CreateTeamInput,
  TeamStoreStats,
  UpdateAgentThreadInput,
  UpdateTeamInput,
} from './team-store.js'
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
export {
  DshRuntimeAdapter,
  GrokRuntimeAdapter,
  HermesRuntimeAdapter,
  RuntimeAdapterError,
  RuntimeAdapterRegistry,
  XaiGrokRuntimeAdapter,
} from './runtime-adapter.js'
export type {
  DshRuntimeAdapterOptions,
  DshRuntimeExecutor,
  HermesRuntimeAdapterOptions,
  HermesRuntimeEvent,
  HermesRuntimeTransport,
  RuntimeAdapter,
  RuntimeAdapterKind,
  RuntimeFetch,
  RuntimeMessage,
  RuntimeMessageRole,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  RuntimeToolDefinition,
  RuntimeUsage,
  XaiGrokRuntimeAdapterOptions,
} from './runtime-adapter.js'
export {
  CronExpressionError,
  RoutineScheduler,
  RoutineStore,
  cronMatches,
  nextCronOccurrence,
  parseCronExpression,
} from './routine.js'
export type {
  CreateRoutineInput,
  ParsedCronExpression,
  RoutineLastRunStatus,
  RoutineLaunch,
  RoutineLaunchHandler,
  RoutineLaunchResult,
  RoutineRecord,
  RoutineSchedulerOptions,
  RoutineStatus,
  UpdateRoutineInput,
} from './routine.js'
