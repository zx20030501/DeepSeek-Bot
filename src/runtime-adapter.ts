export const RUNTIME_ADAPTER_SCHEMA_VERSION = 1

export type RuntimeAdapterKind = 'dsh' | 'hermes' | 'grok'
export type RuntimeMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface RuntimeMessage {
  readonly role: RuntimeMessageRole
  readonly content: string
}

export interface RuntimeToolDefinition {
  readonly name: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
}

export interface RuntimeTaskRequest {
  readonly requestId: string
  readonly botId: string
  readonly sessionId: string
  readonly instruction: string
  readonly systemPrompt?: string
  readonly conversation?: readonly RuntimeMessage[]
  readonly tools?: readonly RuntimeToolDefinition[]
  readonly model?: string
  readonly previousResponseId?: string
  /** Provider-specific metadata. Adapters must not persist credentials from it. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Override the adapter default for providers that expose server-side storage. */
  readonly store?: boolean
  readonly signal?: AbortSignal
}

export interface RuntimeUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
  /** xAI returns exact cost in integer USD ticks in usage metadata. */
  readonly costUsdTicks?: number
}

export interface RuntimeTaskResult {
  readonly requestId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly text: string
  readonly responseId?: string
  readonly usage?: RuntimeUsage
  readonly raw?: unknown
}

export interface RuntimeAdapter {
  readonly kind: RuntimeAdapterKind
  run(request: RuntimeTaskRequest): Promise<RuntimeTaskResult>
  cancel?(requestId: string): Promise<void>
  close?(): Promise<void>
}

export interface RuntimeAdapterErrorOptions {
  readonly retryable?: boolean
  readonly status?: number
  readonly cause?: unknown
}

export class RuntimeAdapterError extends Error {
  public readonly code: string
  public readonly retryable: boolean
  public readonly status?: number
  public readonly cause?: unknown

  public constructor(
    message: string,
    code: string,
    options: RuntimeAdapterErrorOptions = {},
  ) {
    super(message)
    this.name = 'RuntimeAdapterError'
    this.code = code
    this.retryable = options.retryable === true
    if (options.status !== undefined) this.status = options.status
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const direct = stringValue(value.message)
  if (direct !== undefined) return direct
  const error = value.error
  if (isRecord(error)) return stringValue(error.message) ?? stringValue(error.type)
  return stringValue(error)
}

function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length > 0) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const key of ['output_text', 'text']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0) output.push(candidate)
  }
  for (const key of ['content', 'output', 'message', 'result', 'payload']) {
    const nested = value[key]
    if (nested !== undefined && typeof nested !== 'string') {
      collectText(nested, output, depth + 1)
    }
  }
}

function uniqueText(parts: readonly string[]): string {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of parts) {
    if (part.length === 0 || seen.has(part)) continue
    seen.add(part)
    result.push(part)
  }
  return result.join('\n')
}

function abortResult(requestId: string): RuntimeTaskResult {
  return {
    requestId,
    status: 'cancelled',
    text: '',
  }
}

interface LinkedAbort {
  readonly controller: AbortController
  readonly timedOut: () => boolean
  readonly cleanup: () => void
}

function linkedAbortSignal(parent: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController()
  let timeout = false
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timeout = true
      controller.abort(new Error('runtime adapter timeout'))
    }, timeoutMs)
    : undefined
  const onAbort = (): void => {
    controller.abort(parent?.reason)
  }
  if (parent !== undefined) {
    if (parent.aborted) onAbort()
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  return {
    controller,
    timedOut: () => timeout,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function normalizeExecutorResult(
  requestId: string,
  value: RuntimeTaskResult | string,
): RuntimeTaskResult {
  if (typeof value === 'string') {
    return { requestId, status: 'completed', text: value }
  }
  return { ...value, requestId }
}

export type DshRuntimeExecutor = (
  request: RuntimeTaskRequest,
) => Promise<RuntimeTaskResult | string>

export interface DshRuntimeAdapterOptions {
  readonly cancel?: (requestId: string) => Promise<void>
}

export class DshRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'dsh' as const

  public constructor(
    private readonly executor: DshRuntimeExecutor,
    private readonly options: DshRuntimeAdapterOptions = {},
  ) {}

  public async run(request: RuntimeTaskRequest): Promise<RuntimeTaskResult> {
    return normalizeExecutorResult(request.requestId, await this.executor(request))
  }

  public async cancel(requestId: string): Promise<void> {
    await this.options.cancel?.(requestId)
  }
}

export type RuntimeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export interface XaiGrokRuntimeAdapterOptions {
  /** Pass this from the DSH credential service or process environment. */
  readonly apiKey?: string
  readonly apiKeyEnv?: string
  readonly getEnv?: (name: string) => string | undefined
  readonly baseUrl?: string
  readonly model?: string
  /** Defaults to false so prompts stay in the local DSH persistence boundary. */
  readonly store?: boolean
  readonly timeoutMs?: number
  readonly fetch?: RuntimeFetch
}

function xaiInput(request: RuntimeTaskRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (request.systemPrompt !== undefined && request.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: request.systemPrompt })
  }
  for (const message of request.conversation ?? []) {
    messages.push({ role: message.role, content: message.content })
  }
  messages.push({ role: 'user', content: request.instruction })
  return messages
}

function xaiTools(request: RuntimeTaskRequest): Array<Record<string, unknown>> | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined
  return request.tools.map(tool => ({
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
  }))
}

function xaiUsage(value: unknown): RuntimeUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage = isRecord(value.usage) ? value.usage : value
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens)
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens)
  const totalTokens = numberValue(usage.total_tokens)
  const costUsd = numberValue(usage.cost_in_usd)
  const costUsdTicks = numberValue(usage.cost_in_usd_ticks)
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && totalTokens === undefined
    && costUsd === undefined
    && costUsdTicks === undefined
  ) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(costUsdTicks === undefined ? {} : { costUsdTicks }),
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  const raw = await response.text()
  let payload: unknown = raw
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw) as unknown
    } catch {
      payload = raw
    }
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
    throw new RuntimeAdapterError(
      responseErrorMessage(payload) ?? 'xAI HTTP request failed',
      'grok.http_error',
      { retryable, status: response.status },
    )
  }
  return payload
}

function xaiText(value: unknown): string {
  if (!isRecord(value)) return ''
  const direct = stringValue(value.output_text)
  if (direct !== undefined) return direct
  const output = value.output
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const item of output) {
      if (!isRecord(item)) continue
      const type = stringValue(item.type)
      if (type !== undefined && type !== 'message' && type !== 'output_text' && type !== 'text') continue
      collectText(item.content ?? item, parts)
    }
    const result = uniqueText(parts)
    if (result.length > 0) return result
  }
  const parts: string[] = []
  collectText(value.text, parts)
  return uniqueText(parts)
}

export class XaiGrokRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'grok' as const
  private readonly active = new Map<string, AbortController>()
  private readonly apiKey: string | undefined
  private readonly fetchImpl: RuntimeFetch
  private readonly endpoint: string
  private readonly defaultModel: string
  private readonly defaultStore: boolean
  private readonly timeoutMs: number

  public constructor(options: XaiGrokRuntimeAdapterOptions = {}) {
    const envName = options.apiKeyEnv ?? 'XAI_API_KEY'
    const envValue = options.getEnv?.(envName) ?? process.env[envName]
    const apiKey = options.apiKey ?? envValue
    this.apiKey = apiKey?.trim() || undefined
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.endpoint = (options.baseUrl ?? 'https://api.x.ai/v1').replace(/\/+$/u, '') + '/responses'
    this.defaultModel = options.model ?? 'grok-4.6'
    this.defaultStore = options.store ?? false
    this.timeoutMs = options.timeoutMs ?? 600_000
  }

  public async run(request: RuntimeTaskRequest): Promise<RuntimeTaskResult> {
    if (request.signal?.aborted) return abortResult(request.requestId)
    if (this.active.has(request.requestId)) {
      throw new RuntimeAdapterError(
        'A runtime request with this requestId is already active',
        'runtime.request_active',
      )
    }
    if (this.apiKey === undefined) {
      throw new RuntimeAdapterError(
        'xAI API key is not configured',
        'grok.api_key_missing',
      )
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new RuntimeAdapterError(
        'Fetch is not available for the xAI runtime adapter',
        'grok.fetch_unavailable',
      )
    }

    const linked = linkedAbortSignal(request.signal, this.timeoutMs)
    this.active.set(request.requestId, linked.controller)
    try {
      const body: Record<string, unknown> = {
        model: request.model ?? this.defaultModel,
        input: xaiInput(request),
        store: request.store ?? this.defaultStore,
      }
      if (request.previousResponseId !== undefined) body.previous_response_id = request.previousResponseId
      const tools = xaiTools(request)
      if (tools !== undefined) body.tools = tools

      let response: Response
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: 'Bearer ' + this.apiKey,
          },
          body: JSON.stringify(body),
          signal: linked.controller.signal,
        })
      } catch (error: unknown) {
        if (linked.timedOut()) {
          throw new RuntimeAdapterError('xAI request timed out', 'grok.timeout', {
            retryable: true,
            cause: error,
          })
        }
        if (linked.controller.signal.aborted) return abortResult(request.requestId)
        throw new RuntimeAdapterError('xAI request failed', 'grok.network', {
          retryable: true,
          cause: error,
        })
      }

      const payload = await responsePayload(response)
      const text = xaiText(payload)
      if (text.length === 0) {
        throw new RuntimeAdapterError(
          'xAI response did not contain output text',
          'grok.empty_response',
          { retryable: false },
        )
      }
      const responseId = isRecord(payload) ? stringValue(payload.id) : undefined
      const usage = xaiUsage(payload)
      return {
        requestId: request.requestId,
        status: 'completed',
        text,
        ...(responseId === undefined ? {} : { responseId }),
        ...(usage === undefined ? {} : { usage }),
        raw: payload,
      }
    } finally {
      linked.cleanup()
      this.active.delete(request.requestId)
    }
  }

  public async cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.abort(new Error('cancelled by caller'))
  }

  public async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort(new Error('adapter closed'))
    this.active.clear()
  }
}

export class GrokRuntimeAdapter extends XaiGrokRuntimeAdapter {}

export interface HermesRuntimeEvent {
  readonly method?: string
  readonly params?: unknown
  readonly [key: string]: unknown
}

export interface HermesRuntimeTransport {
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
  subscribe?(listener: (event: HermesRuntimeEvent) => void): () => void
  close?(): Promise<void> | void
}

export interface HermesRuntimeAdapterOptions {
  readonly transport: HermesRuntimeTransport
  readonly timeoutMs?: number
  readonly sessionCreateParams?: Readonly<Record<string, unknown>>
  readonly submitMethod?: string
}

function unwrapRpcResult(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.error !== undefined) {
    throw new RuntimeAdapterError(
      responseErrorMessage(value) ?? 'Hermes JSON-RPC request failed',
      'hermes.rpc_error',
      { retryable: false },
    )
  }
  return value.result ?? value
}

function sessionIdFromHermes(value: unknown): string | undefined {
  const result = unwrapRpcResult(value)
  if (!isRecord(result)) return stringValue(result)
  return stringValue(result.session_id)
    ?? stringValue(result.sessionId)
    ?? stringValue(result.id)
}

function hermesText(value: unknown): string {
  const result = unwrapRpcResult(value)
  const parts: string[] = []
  collectText(result, parts)
  return uniqueText(parts)
}

function eventParts(event: HermesRuntimeEvent): {
  readonly type?: string
  readonly sessionId?: string
  readonly payload: unknown
} {
  const params = isRecord(event.params) ? event.params : {}
  const type = stringValue(params.type)
  const sessionId = stringValue(params.session_id) ?? stringValue(params.sessionId)
  return {
    ...(type === undefined ? {} : { type }),
    ...(sessionId === undefined ? {} : { sessionId }),
    payload: params.payload ?? params,
  }
}

interface CompletionWait {
  readonly promise: Promise<string>
  readonly stop: () => void
}

function completionWait(
  transport: HermesRuntimeTransport,
  sessionId: string,
  signal: AbortSignal,
  timeoutMs: number,
): CompletionWait {
  let resolvePromise: ((value: string) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  let unsubscribe: (() => void) | undefined
  let settled = false
  let accumulated = ''
  let completedText = ''
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    unsubscribe?.()
    rejectPromise?.(new RuntimeAdapterError('Hermes response timed out', 'hermes.timeout', {
      retryable: true,
    }))
  }, timeoutMs)
  const onAbort = (): void => {
    if (settled) return
    settled = true
    unsubscribe?.()
    rejectPromise?.(new Error('Hermes request cancelled'))
  }
  const finish = (text: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    unsubscribe?.()
    resolvePromise?.(text)
  }
  const listener = (event: HermesRuntimeEvent): void => {
    const { type, sessionId: eventSessionId, payload } = eventParts(event)
    if (eventSessionId !== sessionId) return
    const parts: string[] = []
    collectText(payload, parts)
    const text = uniqueText(parts)
    if (type === 'message.delta' || type === 'reasoning.delta' || type === 'thinking.delta') {
      accumulated += text
      return
    }
    if (
      type === 'message.complete'
      || type === 'message.completed'
      || type === 'turn.complete'
      || type === 'response.completed'
    ) {
      completedText = text
      finish(completedText || accumulated)
    }
  }
  try {
    unsubscribe = transport.subscribe?.(listener)
  } catch (error: unknown) {
    clearTimeout(timer)
    throw new RuntimeAdapterError('Hermes event subscription failed', 'hermes.subscribe_failed', {
      cause: error,
    })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    stop: () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe?.()
    },
  }
}

export class HermesRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = 'hermes' as const
  private readonly sessions = new Map<string, string>()
  private readonly active = new Map<string, {
    readonly controller: AbortController
    remoteSessionId?: string
  }>()
  private readonly timeoutMs: number
  private readonly sessionCreateParams: Readonly<Record<string, unknown>>
  private readonly submitMethod: string

  public constructor(private readonly options: HermesRuntimeAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.sessionCreateParams = options.sessionCreateParams ?? {}
    this.submitMethod = options.submitMethod ?? 'prompt.submit'
  }

  private async ensureSession(
    request: RuntimeTaskRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const configured = request.metadata?.hermesSessionId
    if (typeof configured === 'string' && configured.length > 0) {
      this.sessions.set(request.sessionId, configured)
      return configured
    }
    const existing = this.sessions.get(request.sessionId)
    if (existing !== undefined) return existing
    const created = await this.options.transport.request(
      'session.create',
      this.sessionCreateParams,
      signal,
    )
    const remoteSessionId = sessionIdFromHermes(created)
    if (remoteSessionId === undefined) {
      throw new RuntimeAdapterError(
        'Hermes session.create did not return a session id',
        'hermes.session_missing',
      )
    }
    this.sessions.set(request.sessionId, remoteSessionId)
    return remoteSessionId
  }

  public async run(request: RuntimeTaskRequest): Promise<RuntimeTaskResult> {
    if (request.signal?.aborted) return abortResult(request.requestId)
    if (this.active.has(request.requestId)) {
      throw new RuntimeAdapterError(
        'A runtime request with this requestId is already active',
        'runtime.request_active',
      )
    }
    const linked = linkedAbortSignal(request.signal, this.timeoutMs)
    const active: {
      readonly controller: AbortController
      remoteSessionId?: string
    } = { controller: linked.controller }
    this.active.set(request.requestId, active)
    let waiter: CompletionWait | undefined
    try {
      const remoteSessionId = await this.ensureSession(request, linked.controller.signal)
      active.remoteSessionId = remoteSessionId
      waiter = this.options.transport.subscribe === undefined
        ? undefined
        : completionWait(
          this.options.transport,
          remoteSessionId,
          linked.controller.signal,
          this.timeoutMs,
        )
      const response = await this.options.transport.request(
        this.submitMethod,
        { session_id: remoteSessionId, text: request.instruction },
        linked.controller.signal,
      )
      const directText = hermesText(response)
      if (directText.length > 0) {
        waiter?.stop()
        const responseId = isRecord(response) ? stringValue(response.id) : undefined
        return {
          requestId: request.requestId,
          status: 'completed',
          text: directText,
          ...(responseId === undefined ? {} : { responseId }),
          raw: response,
        }
      }
      if (waiter === undefined) {
        throw new RuntimeAdapterError(
          'Hermes prompt.submit did not return text and no event subscription is available',
          'hermes.output_missing',
        )
      }
      const streamedText = await waiter.promise
      return {
        requestId: request.requestId,
        status: 'completed',
        text: streamedText,
        raw: response,
      }
    } catch (error: unknown) {
      waiter?.stop()
      if (linked.timedOut()) {
        throw new RuntimeAdapterError('Hermes request timed out', 'hermes.timeout', {
          retryable: true,
          cause: error,
        })
      }
      if (linked.controller.signal.aborted) return abortResult(request.requestId)
      if (error instanceof RuntimeAdapterError) throw error
      throw new RuntimeAdapterError('Hermes runtime request failed', 'hermes.transport', {
        retryable: true,
        cause: error,
      })
    } finally {
      waiter?.stop()
      linked.cleanup()
      this.active.delete(request.requestId)
    }
  }

  public async cancel(requestId: string): Promise<void> {
    const active = this.active.get(requestId)
    if (active === undefined) return
    active.controller.abort(new Error('cancelled by caller'))
    if (active.remoteSessionId !== undefined) {
      try {
        await this.options.transport.request(
          'session.interrupt',
          { session_id: active.remoteSessionId },
        )
      } catch {
        // Local cancellation already fenced the request; remote interrupt is best effort.
      }
    }
  }

  public async close(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort(new Error('adapter closed'))
    this.active.clear()
    await this.options.transport.close?.()
    this.sessions.clear()
  }
}

export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<RuntimeAdapterKind, RuntimeAdapter>()

  public register(adapter: RuntimeAdapter, replace = false): void {
    if (!replace && this.adapters.has(adapter.kind)) {
      throw new RuntimeAdapterError(
        'A runtime adapter is already registered for ' + adapter.kind,
        'runtime.adapter_duplicate',
      )
    }
    this.adapters.set(adapter.kind, adapter)
  }

  public get(kind: RuntimeAdapterKind): RuntimeAdapter | undefined {
    return this.adapters.get(kind)
  }

  public require(kind: RuntimeAdapterKind): RuntimeAdapter {
    const adapter = this.get(kind)
    if (adapter === undefined) {
      throw new RuntimeAdapterError(
        'No runtime adapter is registered for ' + kind,
        'runtime.adapter_missing',
      )
    }
    return adapter
  }

  public async run(kind: RuntimeAdapterKind, request: RuntimeTaskRequest): Promise<RuntimeTaskResult> {
    return this.require(kind).run(request)
  }

  public async close(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.close?.()
    this.adapters.clear()
  }
}
