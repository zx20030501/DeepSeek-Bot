# Runtime Adapters

This module gives the Bot Fleet one execution contract for the local DeepSeek
Harness runtime, Hermes Agent, and xAI/Grok. It is intentionally provider
neutral at the Task/Run boundary:

\`RuntimeTaskRequest -> RuntimeTaskResult\`

The adapter result carries the request ID, normalized text, provider response ID,
usage, and the original provider response for an in-process caller. Credentials
are never part of the request or result contract.

## Adapters

### DSH

\`DshRuntimeAdapter\` wraps a host-owned executor. The existing
\`HarnessBridge\` remains the source of truth for DSH Agent sessions; the
adapter is the seam used by the future Gateway runtime selector.

### Hermes

\`HermesRuntimeAdapter\` speaks the public Hermes TUI Gateway JSON-RPC boundary
through an injected \`HermesRuntimeTransport\`. The transport can be backed by
newline-delimited stdio or WebSocket without adding a WebSocket dependency to
this package.

The adapter uses:

- \`session.create\` once per stable local session ID;
- \`prompt.submit\` for a turn;
- \`session.interrupt\` as best-effort cancellation;
- \`message.delta\` and \`message.complete\`-style events for streamed output.

A host must implement \`request()\` and, when \`prompt.submit\` returns an
acknowledgement rather than final text, \`subscribe()\`.

Hermes documents the same TUI Gateway over stdio and WebSocket in its
[programmatic integration guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)
and its [WebSocket transport source](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/ws.py).

### Grok

\`GrokRuntimeAdapter\` is an alias of \`XaiGrokRuntimeAdapter\`. It calls the
xAI Responses API at \`/v1/responses\), supports conversation input,
\`previous_response_id\`, optional function-tool definitions, response IDs, and
usage/cost metadata.

The default is \`store: false\`. This keeps conversation history inside the
DeepSeek-Harness persistence boundary. A caller must explicitly opt into
xAI-side storage to use server-side response continuation.

The xAI API key is read from the supplied credential or the
\`XAI_API_KEY\` environment variable. Never put it in a profile, settings JSON,
PR, issue, test fixture, or documentation.

## Registry

\`RuntimeAdapterRegistry\` prevents accidental duplicate provider registration
and provides a single lookup point for Task/Run admission:

    const registry = new RuntimeAdapterRegistry()
    registry.register(new DshRuntimeAdapter(executeDsh))
    registry.register(new HermesRuntimeAdapter({ transport: hermesTransport }))
    registry.register(new GrokRuntimeAdapter({
      apiKey: credentials.resolve('XAI_API_KEY'),
      store: false,
    }))

The current slice provides the adapter contract and provider clients. Gateway
Bot-profile selection is deliberately a follow-up integration step so existing
DSH Bots cannot silently change execution provider when this module is added.

## Failure and cancellation rules

- Request IDs are unique among active requests per adapter.
- Explicit cancellation returns a normalized \`cancelled\` result.
- HTTP 408, 409, 429, and 5xx xAI failures are marked retryable.
- Missing credentials, malformed provider output, and unsupported protocol
  responses fail closed.
- Adapter timeouts are bounded and marked retryable.
- Raw provider payloads stay in memory and are returned only to the caller;
  the adapter does not write them to the Bot Fleet journal.

## Official provider boundaries

- [Hermes Agent programmatic integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)
- [Hermes TUI Gateway WebSocket transport](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/ws.py)
- [xAI Generate Text / Responses API](https://docs.x.ai/developers/model-capabilities/text/generate-text)
- [xAI structured outputs and tools](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [xAI cost tracking](https://docs.x.ai/developers/cost-tracking)
