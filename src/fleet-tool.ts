import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FleetHandoffToolResult } from './types.js'

export interface FleetHandoffToolInput {
  readonly toBot: string
  readonly reason: string
  readonly requireApproval?: boolean
}

export type FleetHandoffToolHandler = (
  sessionId: string,
  input: FleetHandoffToolInput,
  execution: ToolRunContext,
) => Promise<FleetHandoffToolResult>

/**
 * A scoped tool installed only on BotMesh-owned Agent sessions. Task, Run,
 * requester, and reply-target identity are derived by the gateway and are not
 * accepted from model-generated arguments.
 */
export function createFleetHandoffTool(handler: FleetHandoffToolHandler) {
  return defineTool({
    name: 'bot_fleet_handoff',
    description: 'Hand the current BotMesh task to another authorized Fleet Bot. This ends the current Bot turn. Use only when another Bot is materially better suited to finish the task.',
    parameters: {
      toBot: {
        type: 'string',
        required: true,
        description: 'Exact Bot ID from the available Fleet roster.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'Concise reason the target Bot should take over and what remains to be done.',
      },
      requireApproval: {
        type: 'boolean',
        description: 'Request explicit human approval even if policy would otherwise allow the handoff.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['accepted', 'pending-approval'], required: true },
          handoffId: { type: 'string', required: true },
          toBot: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, execution) {
      if (execution.signal.aborted) throw new Error('Bot Fleet handoff was cancelled before dispatch')
      if (execution.agent === undefined) throw new Error('Bot Fleet handoff requires a live Agent')
      const result = await handler(String(execution.agent.id), args, execution)
      execution.concludeTurn()
      return result
    },
  })
}
