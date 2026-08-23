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
    '/bot create <id> [名称] — 建立只属于当前用户的 Bot 草稿',
    '/bot confirm <code> — 用 8 位确认码激活 Bot 草稿',
    '/bot list — 查看自己的动态 Bot、状态和待确认码',
    '/bot status <id> — 查看动态 Bot 的 Fleet 加入、忙碌和最近失败状态',
    '动态 Bot 流程：设置页同时开启“动态 Bot 注册表”和“允许在对话中创建 Bot”，发送 /new → /bot create → /bot confirm。',
    'Team 不会自动扩权：用 /teams 和 /team add/remove 显式维护成员。',
    '@team:<team-id> <任务> — 按 Team 成员快照启动有界协作 Thread/Room；只有一个可见 Team 时可省略 ID。',
    '/bot edit|disable|enable|delete|clone … — 管理自己的动态 Bot',
    '/teams — 查看当前用户可见的 Team',
    '/team create|add|remove|manager|status … — 显式管理 Team 成员和状态',
    '/mesh — 查看你自己的 BotMesh mailbox、task、run 和 handoff 状态',
    '/fleet <任务> — 自动规划并行 Bot 工作流（执行→验证→汇总）',
    '/routine list — 查看当前用户的定时 Workflow',
    '/routine create <workflowId> | <cron> | <名称> | <timezone> | <JSON输入> — 创建定时 Workflow',
    '/routine enable|disable|delete <routineId> — 管理定时 Workflow',
    '/tasks — 查看自己最近的 Fleet 任务',
    '/task <id> — 查看自己的某个任务、Run 和结果摘要',
    '/cancel <id> — 取消自己的任务并停止关联 Bot',
    '/replay <id> — 用全新的 Task/Run 安全重放一个已结束任务',
    '/approvals — 查看自己的待审批操作',
    '/approve <code> / /reject <code> — 批准或拒绝 Fleet 操作',
    '/model [provider:model] — 查看或设置当前 profile 的下一回合模型',
    '/help — 显示帮助',
    '',
    '使用 @bot-name <任务> 可把任务交给另一个 Bot；同时 @多个 Bot 会创建有界协作房间，每一轮会让所有参与 Bot 各执行一次。',
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
