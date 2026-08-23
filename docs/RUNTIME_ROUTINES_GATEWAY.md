# Gateway integration for Runtime Adapters and Routines

This migration connects the already durable Runtime Adapter and Routine cores to
the \`BotGateway\`.

## Runtime selection

A static profile can select a runtime explicitly:

\`\`\`json
{
  "profiles": {
    "local": {
      "runtimeAdapter": "dsh"
    },
    "hermes-worker": {
      "runtimeAdapter": "hermes",
      "model": "hermes-default"
    },
    "grok-reviewer": {
      "runtimeAdapter": "grok",
      "model": "grok-4.6"
    }
  },
  "collaboration": {
    "features": {
      "externalRuntimes": true
    }
  }
}
\`\`\`

\`dsh\` remains the default and continues to use the DeepSeek Harness Agent
session. \`hermes\` is host-injected through \`registerRuntimeAdapter()\` with a
\`HermesRuntimeTransport\`; the Gateway does not own a WebSocket or stdio
connection. \`grok\` is provided by the built-in xAI Responses adapter and reads
\`XAI_API_KEY\` from the process credential environment.

External adapters are selected only when \`externalRuntimes\` is explicitly
enabled. A missing adapter or provider error is converted into the existing
Task/Run retry and dead-letter path. Shutdown calls the adapter cancellation
hook before the mailbox lease is relinquished.

Provider credentials are never accepted in Bot profiles, Workflow inputs,
Routine inputs, or durable Gateway state. Do not put API keys in JSON settings.

## Routine commands

Routines require both \`savedWorkflows\` and \`routines\`:

\`\`\`json
{
  "collaboration": {
    "features": {
      "savedWorkflows": true,
      "routines": true
    }
  }
}
\`\`\`

A user can then run:

\`\`\`text
/routine list
/routine create <workflowId> | <cron> | <name> | <IANA timezone> | <JSON object>
/routine enable <routineId>
/routine disable <routineId>
/routine delete <routineId>
\`\`\`

Example:

\`\`\`text
/routine create wf_daily_report | 0 9 * * 1-5 | Weekday report | Asia/Singapore | {"source":"schedule"}
\`\`\`

The command verifies that the Workflow is visible to the current requester and
stores the reply target with the durable Routine. The scheduler writes a
launch reservation before calling \`launchWorkflowDefinition()\`, so a process
restart reuses the same launch ID instead of duplicating the scheduled run.

Routine ownership is enforced by the Gateway. The local dashboard may manage
all routines; chat users can list and mutate only their own records.

## Recovery boundary

The scheduler is started after durable Gateway state is loaded and stopped
before transport shutdown completes. It produces only structured
\`RoutineLaunch\` values. Workflow admission remains responsible for revision
pinning, input validation, ACL, approval, budget, mailbox delivery, and final
reply routing.
