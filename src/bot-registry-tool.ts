import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface BotCreateDraftToolInput {
  readonly handle: string
  readonly title: string
  readonly description?: string
  readonly capabilities?: readonly string[]
  readonly skills?: readonly string[]
  readonly role?: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  readonly model?: string
  readonly runtimeAdapter?: 'dsh' | 'hermes' | 'grok'
  readonly soul?: string
}

export interface BotCreateDraftToolResult {
  readonly status: 'draft' | 'active'
  readonly botId: string
  readonly handle: string
  readonly confirmationCode?: string
  readonly message: string
}

export type BotCreateDraftToolHandler = (
  sessionId: string,
  input: BotCreateDraftToolInput,
  execution: ToolRunContext,
) => Promise<BotCreateDraftToolResult>

export interface BotUpdateDraftToolInput {
  readonly handle: string
  readonly title?: string
  readonly description?: string
  readonly capabilities?: readonly string[]
  readonly skills?: readonly string[]
  readonly role?: 'worker' | 'verifier' | 'synthesizer' | 'generalist'
  readonly model?: string
  readonly runtimeAdapter?: 'dsh' | 'hermes' | 'grok'
  readonly soul?: string
}

export interface BotUpdateDraftToolResult {
  readonly status: 'draft'
  readonly botId: string
  readonly handle: string
  readonly version: number
  readonly confirmationCode: string
  readonly message: string
}

export type BotUpdateDraftToolHandler = (
  sessionId: string,
  input: BotUpdateDraftToolInput,
  execution: ToolRunContext,
) => Promise<BotUpdateDraftToolResult>

/**
 * User-session tool for natural-language Bot creation. Ownership, ACL, scope,
 * and requester identity are derived by the gateway, never model arguments.
 */
export function createBotCreateDraftTool(handler: BotCreateDraftToolHandler) {
  return defineTool({
    name: 'bot_create_draft',
    description: 'Create a new private Fleet Bot draft for the current user. The Bot is not usable until the user confirms the returned 8-character code with /bot confirm CODE.',
    parameters: {
      handle: {
        type: 'string',
        required: true,
        description: 'Short lowercase Bot handle using letters, digits, hyphen, or underscore.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Human-readable Bot name.',
      },
      description: { type: 'string', description: 'What this Bot is responsible for.' },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short capability labels used by the Fleet planner.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skill names associated with this Bot.',
      },
      role: {
        type: 'string',
        enum: ['worker', 'verifier', 'synthesizer', 'generalist'],
        description: 'Fleet role. Manager Bots are not enabled in this phase.',
      },
      model: { type: 'string', description: 'Optional model name; omit to inherit the DSH default.' },
      runtimeAdapter: {
        type: 'string',
        enum: ['dsh', 'hermes', 'grok'],
        description: 'Execution runtime. Hermes and Grok require the corresponding host adapter and feature flag.',
      },
      soul: { type: 'string', description: 'Optional short identity and behavior prompt. Never include credentials.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['draft', 'active'], required: true },
          botId: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          confirmationCode: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, execution) {
      if (execution.signal.aborted) throw new Error('Bot draft creation was cancelled')
      if (execution.agent === undefined) throw new Error('Bot draft creation requires a live Agent')
      return handler(String(execution.agent.id), args, execution)
    },
  })
}

/** Update content on an owned draft without exposing lifecycle or ACL fields. */
export function createBotUpdateDraftTool(handler: BotUpdateDraftToolHandler) {
  return defineTool({
    name: 'bot_update_draft',
    description: 'Update an existing private Fleet Bot draft before the user confirms it. This cannot activate a Bot or change owner, ACL, scope, or session identity.',
    parameters: {
      handle: { type: 'string', required: true, description: 'Exact handle of the current user\'s draft Bot.' },
      title: { type: 'string', description: 'New human-readable Bot name.' },
      description: { type: 'string', description: 'New responsibility description.' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Replacement capability labels.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Replacement skill names.' },
      role: { type: 'string', enum: ['worker', 'verifier', 'synthesizer', 'generalist'], description: 'Replacement Fleet role.' },
      model: { type: 'string', description: 'Replacement model name.' },
      runtimeAdapter: {
        type: 'string',
        enum: ['dsh', 'hermes', 'grok'],
        description: 'Replacement execution runtime.',
      },
      soul: { type: 'string', description: 'Replacement identity prompt. Never include credentials.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['draft'], required: true },
          botId: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          version: { type: 'number', required: true },
          confirmationCode: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, execution) {
      if (execution.signal.aborted) throw new Error('Bot draft update was cancelled')
      if (execution.agent === undefined) throw new Error('Bot draft update requires a live Agent')
      return handler(String(execution.agent.id), args, execution)
    },
  })
}
