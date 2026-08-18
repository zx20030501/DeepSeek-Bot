import type { ModelOverride } from './types.js'

export interface ParsedBotCommand {
  readonly name: string
  readonly args: string
}

/** Parse the optional provider:model form accepted by /model. */
export function parseModelOverride(value: string): ModelOverride {
  const separator = value.indexOf(':')
  if (separator <= 0) return { model: value }
  const provider = value.slice(0, separator).trim()
  const model = value.slice(separator + 1).trim()
  return provider && model ? { provider, model } : { model: value }
}

export function formatModelOverride(value: ModelOverride | string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value.provider === undefined ? value.model : `${value.provider}:${value.model}`
}

const COMMAND_RE = /^\s*\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?\s*$/iu

export function parseBotCommand(text: string): ParsedBotCommand | undefined {
  const match = COMMAND_RE.exec(text)
  if (!match) return undefined
  const name = match[1]
  if (!name) return undefined
  return { name: name.toLowerCase(), args: (match[2] ?? '').trim() }
}

export function splitText(text: string, maxLength: number): string[] {
  if (maxLength <= 0) throw new Error('maxLength must be positive')
  const points = [...text]
  if (points.length === 0) return ['']
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += maxLength) {
    chunks.push(points.slice(index, index + maxLength).join(''))
  }
  return chunks
}

export function formatHelp(): string {
  return [
    'DeepSeek Bot',
    '',
    '/new — 新建当前聊天会话',
    '/stop — 停止当前 Agent 回合',
    '/status — 查看网关、队列和会话状态',
    '/bots — 查看可用 Bot profile',
    '/bot <name> — 切换 Bot profile',
    '/mesh — 查看 BotMesh 的 mailbox、task、run 和 handoff 状态',
    '/model [provider:model] — 查看或设置当前 profile 的下一回合模型',
    '/help — 显示帮助',
    '',
    '使用 @bot-name <任务> 可把任务交给另一个 Bot；同时 @多个 Bot 会创建最多 3 轮的协作房间。',
    '其他普通消息和未知 / 命令会交给 DeepSeek Harness 处理。',
  ].join('\n')
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      Boolean(block)
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('')
    .trim()
}

export function redactId(value: string | number | undefined): string {
  const text = String(value ?? '')
  if (text.length <= 4) return '****'
  return `${text.slice(0, 2)}…${text.slice(-2)}`
}
