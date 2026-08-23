# Routine / cron

Routines are durable triggers for saved Workflows. A routine never executes
free-form text directly. Its only output is a structured \`RoutineLaunch\`:

- routine ID and stable launch ID;
- owner and Workflow ID;
- scheduled timestamp and attempt number;
- JSON-safe Workflow inputs;
- optional reply target.

The host Gateway is responsible for converting that launch into the existing
Workflow Task/Run admission path and applying ACL, approval, budget, and
revision pinning before execution.

## Cron syntax

The first slice supports five numeric fields:

    minute hour day-of-month month day-of-week

Supported operators are \`*\`, lists, ranges, and positive steps, for example:

    */15 * * * *
    0 9 * * 1-5
    30 2 1,15 * *
    0 0 * * 0

Day-of-week accepts 0 or 7 for Sunday. Named months and named weekdays are
intentionally not accepted yet. When both day-of-month and day-of-week are
restricted, the standard cron OR rule is used.

Schedules default to UTC. An IANA timezone can be supplied; matching uses
\`Intl.DateTimeFormat\` and follows the host's timezone database.

## Durable reservation

\`RoutineStore.claimDue()\` writes a pending launch before returning it. The
launch ID is deterministic for the routine and scheduled timestamp:

    routine-run:<routine-id>:<scheduled-at>

A short lease prevents two scheduler ticks from dispatching the same launch at
the same time. If the process dies, a later scheduler instance recovers the
same launch after the lease expires. A failed launch can retry with the same
ID and bounded exponential backoff. A successful or exhausted launch advances
the routine to the next cron occurrence.

Routine inputs are scanned for credential material before persistence. Put
provider keys in the DSH CredentialProvider or environment, never in routine
inputs.

## Scheduler lifecycle

    const store = new RoutineStore(stateDir + '/routines.jsonl')
    const scheduler = new RoutineScheduler({
      store,
      launch: launch => gateway.launchWorkflowFromRoutine(launch),
    })
    scheduler.start()

Call \`await scheduler.stop()\` during Gateway shutdown. On startup, load the
store and start the scheduler only after Workflow recovery and the normal
admission services are ready.

The Gateway integration provides /routine commands, settings flags, ownership
checks, and a concrete launch path through the existing Workflow admission
runtime. The scheduler still emits only structured launches; ACL, approval,
budget, revision pinning, and mailbox delivery remain the Workflow runtime's
responsibility.
