import {
  createLarkChannel,
  Domain,
  type LarkChannelOptions,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk'
import type {
  BotTarget,
  FeishuConfig,
  FeishuEventDiagnostic,
  InboundMessage,
  OutboundTarget,
  BotTransport,
} from './types.js'

interface FeishuChannelLike {
  on(event: string, handler: (...args: unknown[]) => unknown): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(
    to: string,
    input: { markdown: string },
    options?: { replyTo?: string; replyInThread?: boolean },
  ): Promise<unknown>
  getConnectionStatus?(): unknown
}

export type FeishuChannelFactory = (options: LarkChannelOptions) => FeishuChannelLike

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function rawEventId(raw: unknown): string | undefined {
  const record = asRecord(raw)
  const header = asRecord(record.header)
  const id = header.event_id ?? record.event_id
  return typeof id === 'string' ? id : undefined
}

function resourceText(message: NormalizedMessage): string {
  return message.resources
    .map(resource => `[飞书 ${resource.type}${resource.fileName ? `：${resource.fileName}` : ''}]`)
    .join('\n')
}

/** Convert the official SDK's normalized event to the gateway's platform-neutral message. */
export function toFeishuInbound(message: NormalizedMessage): InboundMessage | undefined {
  const content = message.content.trim()
  const attachments = resourceText(message)
  const text = [content, attachments].filter(Boolean).join(content && attachments ? '\n' : '').trim()
  if (!text) return undefined
  const eventId = rawEventId(message.raw)
  const threadId = message.threadId ?? message.rootId
  const replyToMessageId = message.replyToMessageId
  const target: BotTarget = {
    platform: 'feishu',
    chatId: message.chatId,
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    userId: message.senderId,
    chatType: message.chatType === 'p2p' ? 'dm' : 'group',
  }
  return {
    id: `feishu:message:${message.messageId}`,
    ...(eventId === undefined ? {} : { updateId: eventId }),
    target,
    text,
    receivedAt: message.createTime || Date.now(),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    raw: message.raw,
  }
}

function defaultFactory(options: LarkChannelOptions): FeishuChannelLike {
  return createLarkChannel(options) as unknown as FeishuChannelLike
}

/** Feishu/Lark app-bot transport using the official SDK's WebSocket mode. */
export class FeishuTransport implements BotTransport {
  public readonly platform = 'feishu'
  private readonly appId: string
  private readonly appSecret: string
  private readonly options: LarkChannelOptions
  private readonly factory: FeishuChannelFactory
  private channel: FeishuChannelLike | undefined
  private loopPromise: Promise<void> | undefined
  private resolveStop: (() => void) | undefined
  private stopRequested = false
  private running = false
  private connected = false
  private lastError: string | undefined
  private inboundEventCount = 0
  private lastInboundEvent: FeishuEventDiagnostic | null = null

  public constructor(config: FeishuConfig = {}, factory: FeishuChannelFactory = defaultFactory) {
    this.appId = config.appId?.trim() ?? ''
    this.appSecret = config.appSecret?.trim() ?? ''
    this.factory = factory
    this.options = {
      appId: this.appId,
      appSecret: this.appSecret,
      transport: 'websocket',
      domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      handshakeTimeoutMs: Math.max(1_000, Math.min(60_000, config.handshakeTimeoutMs ?? 15_000)),
      policy: {
        // The gateway's own allowlist remains the final authorization boundary.
        dmMode: 'open',
        requireMention: config.requireMention !== false,
      },
      safety: {
        // InboundWal and BotGateway already provide durable deduplication and
        // per-target serialization; avoid a second in-memory queue here.
        chatQueue: { enabled: false },
        dedup: { ttl: 24 * 60 * 60 * 1_000, maxEntries: 20_000 },
      },
      outbound: {
        textChunkLimit: Math.max(500, Math.min(30_000, config.maxMessageChars ?? 4_000)),
        retry: { maxAttempts: 1 },
      },
      source: 'dsh-hermes-bot',
    }
  }

  public start(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (!this.appId || !this.appSecret) return Promise.reject(new Error('Feishu appId/appSecret are not configured'))
    if (this.loopPromise) return this.loopPromise
    this.stopRequested = false
    this.running = true
    this.loopPromise = this.run(handler).catch(error => {
      this.lastError = String(error)
      throw error
    }).finally(() => {
      this.running = false
      this.connected = false
      this.loopPromise = undefined
      this.resolveStop = undefined
    })
    return this.loopPromise
  }

  public async stop(): Promise<void> {
    this.stopRequested = true
    this.running = false
    this.resolveStop?.()
    await this.loopPromise?.catch(() => undefined)
  }

  public async send(target: OutboundTarget, text: string): Promise<void> {
    if (!this.channel || !this.connected) throw new Error('Feishu WebSocket transport is not connected')
    const options = target.replyToMessageId === undefined
      ? undefined
      : {
          replyTo: target.replyToMessageId,
          ...(target.threadId === undefined ? {} : { replyInThread: true }),
        }
    await this.channel.send(target.chatId, { markdown: text }, options)
  }

  public status(): Record<string, unknown> {
    return {
      platform: this.platform,
      running: this.running,
      connected: this.connected,
      domain: this.options.domain === Domain.Lark ? 'lark' : 'feishu',
      connection: this.channel?.getConnectionStatus?.(),
      inbound: {
        received: this.inboundEventCount,
        last: this.lastInboundEvent,
      },
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  private async run(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    const channel = this.factory(this.options)
    this.channel = channel
    channel.on('message', async (...args: unknown[]) => {
      const normalized = args[0] as NormalizedMessage
      try {
        const message = toFeishuInbound(normalized)
        this.recordInboundEvent(normalized, message === undefined ? 'empty_text' : 'normalized', message !== undefined)
        if (message) await handler(message)
      } catch (error) {
        this.recordInboundEvent(normalized, 'processing_error', false)
        this.lastError = `inbound message handling failed: ${String(error)}`
      }
    })
    channel.on('error', (...args: unknown[]) => {
      this.lastError = String(args[0])
    })
    channel.on('reconnecting', () => {
      this.connected = false
    })
    channel.on('reconnected', () => {
      this.connected = true
    })
    try {
      await channel.connect()
    } catch (error) {
      this.lastError = String(error)
      throw error
    }
    this.connected = true
    await new Promise<void>(resolve => {
      this.resolveStop = resolve
      if (this.stopRequested) resolve()
    })
    await channel.disconnect()
  }

  private recordInboundEvent(
    message: NormalizedMessage,
    reason: string,
    normalized: boolean,
  ): void {
    this.inboundEventCount += 1
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    const resources = Array.isArray(message.resources) ? message.resources.length : 0
    this.lastInboundEvent = {
      receivedAt: Date.now(),
      ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
      ...(typeof message.senderId === 'string' ? { userId: message.senderId } : {}),
      ...(typeof message.chatId === 'string' ? { chatId: message.chatId } : {}),
      ...(typeof message.chatType === 'string' ? { chatType: message.chatType } : {}),
      ...(typeof message.mentionedBot === 'boolean' ? { mentionedBot: message.mentionedBot } : {}),
      textLength: content.length,
      resourceCount: resources,
      normalized,
      reason,
    }
  }
}
