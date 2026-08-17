import type { Context } from '@deepseek-ai/cordis'
import { BotGateway } from './gateway.js'

export const name = 'dsh-hermes-bot'

// The plugin deliberately depends only on the public Agent seam. The session
// event stream is available in a normal DSH Agent composition and does not
// require us to fork or patch the official Agent Loop.
export const inject = ['agents']

export function apply(ctx: Context, config: unknown = {}): void {
  const gateway = new BotGateway(ctx, config)
  ctx.on('session/event', (session, event) => gateway.onSessionEvent(session, event))
  ctx.effect(() => {
    void gateway.start().catch(error => {
      const logger = (ctx as unknown as { logger?: { error?: (message: string) => void } }).logger
      logger?.error?.(`[dsh-hermes-bot] startup failed: ${String(error)}`)
    })
    return () => gateway.stop()
  }, 'dsh-hermes-bot.lifecycle()')
}

export { BotGateway } from './gateway.js'
export { InboundWal, Outbox } from './durable.js'
export { parseBotCommand, splitText } from './commands.js'
export { TelegramTransport } from './telegram.js'
export { FeishuTransport, toFeishuInbound } from './feishu.js'
export type * from './types.js'
