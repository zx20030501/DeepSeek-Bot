import { splitText } from './commands.js'
import type { BotTarget, BotTransport, InboundMessage, OutboundTarget, TelegramConfig } from './types.js'

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    chat: { id: number | string; type?: string }
    from?: { id: number | string }
    message_thread_id?: number
    reply_to_message?: { message_id?: number }
    document?: { file_name?: string }
    photo?: readonly unknown[]
    voice?: unknown
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

type FetchLike = typeof fetch

function isAbort(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

function asString(value: string | number | undefined): string {
  return String(value ?? '')
}

/** Minimal-dependency Telegram long-polling adapter. */
export class TelegramTransport implements BotTransport {
  public readonly platform = 'telegram'
  private readonly token: string
  private readonly pollTimeoutSeconds: number
  private readonly requestTimeoutMs: number
  private readonly controller = new AbortController()
  private running = false
  private offset: number | undefined
  private loopPromise: Promise<void> | undefined
  private readonly fetchFn: FetchLike

  public constructor(config: TelegramConfig = {}, fetchFn: FetchLike = fetch) {
    this.token = config.token ?? ''
    this.pollTimeoutSeconds = Math.max(1, Math.min(50, config.pollTimeoutSeconds ?? 30))
    this.requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? 70_000)
    this.fetchFn = fetchFn
  }

  public start(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (!this.token) return Promise.reject(new Error('Telegram token is not configured'))
    if (this.loopPromise) return this.loopPromise
    this.running = true
    this.loopPromise = this.poll(handler).finally(() => {
      this.running = false
      this.loopPromise = undefined
    })
    return this.loopPromise
  }

  public async stop(): Promise<void> {
    this.running = false
    this.controller.abort()
    await this.loopPromise?.catch(() => undefined)
  }

  public async send(target: OutboundTarget, text: string): Promise<void> {
    const chunks = splitText(text, 4096)
    for (const [index, chunk] of chunks.entries()) {
      const payload: Record<string, unknown> = {
        chat_id: target.chatId,
        text: chunk,
        disable_web_page_preview: true,
      }
      if (target.threadId !== undefined) payload.message_thread_id = Number(target.threadId)
      if (index === 0 && target.replyToMessageId !== undefined) {
        payload.reply_parameters = { message_id: Number(target.replyToMessageId) }
      }
      await this.call('sendMessage', payload)
    }
  }

  public async typing(target: BotTarget): Promise<void> {
    await this.call('sendChatAction', { chat_id: target.chatId, action: 'typing' })
  }

  public status(): Record<string, unknown> {
    return {
      platform: this.platform,
      running: this.running,
      offset: this.offset,
      pollTimeoutSeconds: this.pollTimeoutSeconds,
    }
  }

  private async poll(handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    let retryMs = 1_000
    while (this.running && !this.controller.signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', {
          ...(this.offset === undefined ? {} : { offset: this.offset }),
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ['message'],
        })
        retryMs = 1_000
        for (const update of updates) {
          this.offset = update.update_id + 1
          const message = this.toInbound(update)
          if (!message) continue
          await handler(message)
        }
      } catch (error: unknown) {
        if (!this.running || this.controller.signal.aborted || isAbort(error)) return
        await new Promise(resolve => {
          const timer = setTimeout(resolve, retryMs)
          timer.unref?.()
        })
        retryMs = Math.min(60_000, retryMs * 2)
      }
    }
  }

  private toInbound(update: TelegramUpdate): InboundMessage | undefined {
    const message = update.message
    if (!message) return undefined
    const attachment = message.document?.file_name
      ? `\n[Telegram 文件：${message.document.file_name}]`
      : message.photo
        ? '\n[Telegram 图片附件]'
        : message.voice
          ? '\n[Telegram 语音附件]'
          : ''
    const text = `${message.text ?? message.caption ?? ''}${attachment}`.trim()
    if (!text) return undefined
    const target: BotTarget = {
      platform: this.platform,
      chatId: asString(message.chat.id),
      ...(message.message_thread_id === undefined ? {} : { threadId: asString(message.message_thread_id) }),
      ...(message.from?.id === undefined ? {} : { userId: asString(message.from.id) }),
      chatType: message.chat.type === 'private' ? 'dm' : message.message_thread_id === undefined ? 'group' : 'thread',
    }
    return {
      id: `telegram:update:${update.update_id}`,
      updateId: asString(update.update_id),
      target,
      text,
      receivedAt: Date.now(),
      ...(message.reply_to_message?.message_id === undefined
        ? {}
        : { replyToMessageId: asString(message.reply_to_message.message_id) }),
      raw: update,
    }
  }

  private async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new Error('Telegram token is not configured')
    const requestController = new AbortController()
    const relayAbort = (): void => requestController.abort()
    this.controller.signal.addEventListener('abort', relayAbort, { once: true })
    const timer = setTimeout(() => requestController.abort(), this.requestTimeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: requestController.signal,
      })
      const body = await response.json() as TelegramResponse<T>
      if (!response.ok || !body.ok) {
        throw new Error(`Telegram ${method} failed: ${body.description ?? response.statusText}`)
      }
      return body.result as T
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', relayAbort)
    }
  }
}
