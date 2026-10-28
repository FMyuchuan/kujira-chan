/** Direct Messages transport with one cancellable lifecycle per model request. */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageAttachmentAccessResolver, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { modelInfo } from './model-info.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions as Connection } from './types.ts'
import { DeepSeekFileStore } from './file-store.ts'
import { MESSAGES_FILES_BETA, MESSAGES_TOOL_CHANGES_BETA, messagesApiRoot } from './messages-api.ts'
import { FileResolutionFailure, RequestFiles } from './request-files.ts'
import { prepareRequestExtensions } from './request-extensions.ts'
import { imagePricing, inlineImages, prepareFileIds, prepareImages } from './images.ts'
import { serialize } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { providerError, providerErrorDetail } from './transport.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { resolveRequestImageTarget } from './request-pricing.ts'

/** DeepSeek provider using Messages content and native thinking replay. */
/** One parked forward-only turn receiving the persona main session's answers live. */
interface ForwardSink {
  /** Text accumulated so far. */
  buffer: string
  /** Set when the persona main session finished its turn. */
  ended: boolean
  /** Whether anything was emitted. */
  present: boolean
}

export class DeepSeekAdapter<C extends Connection = Connection> extends LlmAdapter {
  private readonly files: DeepSeekFileStore
  private readonly imageAccess: ImageAttachmentAccessResolver = (ref) => {
    const attachments = this.dependencies.resolveAttachments?.()
    return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref)
  }

  constructor(private readonly dependencies: DeepSeekAdapterOptions<C>) {
    super()
    this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  override providerInfo(provider: string) { return { id: provider, name: this.dependencies.providerName ?? 'DeepSeek' } }
  override providerRetryPolicy(_provider: string) { return this.dependencies.options().retryPolicy }
  override async listModels(provider: string) {
    return this.dependencies.discoverModels?.(provider) ?? []
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return modelInfo(await this.connection(signal), provider, model)
  }
  override imageRequestPricing(_provider: string, model: string) {
    return imagePricing(this.dependencies.options(), model, this.imageAccess)
  }
  override imageRequestTarget(_provider: string, model: string, image: ImageAttachmentRef) {
    const entry = this.dependencies.options().models.find(entry => entry.id === model)
    if (entry === undefined) throw new LlmError(`DeepSeek model "${model}" has no declared image projection`, 'UNKNOWN_MODEL')
    return resolveRequestImageTarget(entry, image)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = await this.connection(signal)
    this.dependencies.admit?.(connection, model)
    return { model: modelInfo(connection, provider, model), stream: options => this.generate(options, connection) }
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.dependencies.options()
    this.dependencies.admit?.(connection, options.model)
    return this.generate(options, connection)
  }

  private connection(signal: AbortSignal | undefined): Promise<C> {
    return this.dependencies.connect?.(signal) ?? Promise.resolve(this.dependencies.options())
  }

  private async * generate(options: GenerateOptions, connection: C): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, 'MESSAGES_IDLE')
    const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse() })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort()
      // The abort above owns the socket teardown. A demand the deadline abandoned
      // can stay pending forever, and this generator queues its own return behind
      // that demand, so awaiting the drain would re-hang the settled outcome.
      /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned request. */
      void iterator.return(undefined).catch(() => {})
    }
  }

  private async * request(
    options: GenerateOptions, connection: C, signal: AbortSignal, activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    // A sibling session in a Kujira Chan persona workspace only forwards its
    // message to the persona main session. The live probe is authoritative; the
    // file list is a fallback for a probe that has not registered yet.
    let forwardOnly = false
    let probeAnswer: boolean | undefined
    let listedAnswer: boolean | undefined
    try {
      const probeSlot = globalThis as unknown as Record<symbol, unknown>
      const probe = probeSlot[Symbol.for('dsh.kujira.isForwardOnly')] as ((id: string) => boolean) | undefined
      probeAnswer = probe?.(String(options.sessionId))
      forwardOnly = probeAnswer === true
      if (!forwardOnly) {
        const { readFile } = await import('node:fs/promises')
        const raw = await readFile('/root/.dsh/kujira-silent-sessions.json', 'utf8')
        const parsed: unknown = JSON.parse(raw)
        const sessions = (parsed as { sessions?: unknown }).sessions
        listedAnswer = Array.isArray(sessions) && sessions.includes(String(options.sessionId))
        forwardOnly = listedAnswer
      }
    } catch (error: unknown) {
      // Neither source resolved: treat the session as ordinary.
    }
    if (forwardOnly) {
        // Forward-only session: park this turn and stream the answers the persona
        // main session produces into it as they arrive, so the reply reads like a
        // normal streamed answer instead of appearing only at the very end.
        const registrySlot = globalThis as unknown as Record<symbol, unknown>
        const waitersKey = Symbol.for('dsh.kujira.forwardWaiters')
        const registry = (registrySlot[waitersKey] as Map<string, ForwardSink> | undefined)
          ?? (registrySlot[waitersKey] = new Map<string, ForwardSink>()) as Map<string, ForwardSink>
        const key = String(options.sessionId)
        if (registry.has(key)) {
          // Another turn of this session is already parked for the same answer.
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const sink: ForwardSink = { buffer: '', ended: false, present: false }
        registry.set(key, sink)
        let started = false
        let sent = 0
        try {
          while (!sink.ended && !signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 120))
            if (sink.buffer.length > sent) {
              const delta = sink.buffer.slice(sent)
              sent = sink.buffer.length
              if (!started) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                started = true
              }
              yield { type: 'text-delta', index: 0, text: delta }
              sink.present = true
            }
            activity()
          }
        } finally {
          registry.delete(key)
        }
        if (sink.buffer.length > sent) {
          if (!started) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            started = true
          }
          yield { type: 'text-delta', index: 0, text: sink.buffer.slice(sent) }
        }
        if (started) yield { type: 'block-end', index: 0, block: { type: 'text', text: sink.buffer } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    const { messages, versions } = await prepareImages(
      options.messages, connection, options.model, this.dependencies.resolveAttachments?.(), this.imageAccess, signal,
    )
    const auth = await this.dependencies.resolveAuth(connection)
    try {
      const files = new RequestFiles(this.files, {
        baseURL: connection.baseURL, headers: auth.headers,
      },
      connection.filePolicy, connection.filesApiTimeoutMs, signal, activity)
      let inline = false
      while (true) {
        signal.throwIfAborted()
        files.beginAttempt()
        let fileIds: Awaited<ReturnType<typeof prepareFileIds>> | undefined
        if (!inline) {
          try {
            fileIds = await prepareFileIds(messages, versions, files)
          } catch (error) {
            if (!(error instanceof FileResolutionFailure)) throw error
            inline = true
            continue
          }
        }
        const history = inline ? inlineImages(messages, versions, connection) : messages
        const body = serialize(options, connection, history, versions, this.imageAccess, (reason) => {
          this.dependencies.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
        }, fileIds)
        const extensions = await prepareRequestExtensions(body as Readonly<Record<string, DeepSeekLlmApiJson>>, {
          signal,
          ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
          ...options.purpose === undefined ? {} : { purpose: options.purpose },
        }, this.dependencies.prepareExtensions, (fields, error) => {
          this.dependencies.onExtensionsOmitted?.({ provider: options.provider, model: options.model, fields, error })
        }, (error) => {
          this.dependencies.onExtensionsUnaccepted?.({ provider: options.provider, model: options.model, error })
        })
        signal.throwIfAborted()
        const betas = [
          ...fileIds !== undefined && fileIds.size > 0 ? [MESSAGES_FILES_BETA] : [],
          ...body.messages.some(message => message.content.some(block => block.type === 'tool_addition' || block.type === 'tool_removal'))
            ? [MESSAGES_TOOL_CHANGES_BETA]
            : [],
        ]
        // Temporary diagnostic: dump the exact request body the API receives.
        try {
          const { writeFile } = await import('node:fs/promises')
          await writeFile('/tmp/llm-last-request.json', String(extensions.payload ?? ''), 'utf8')
        } catch {
          // Diagnostic only; never fail a turn because the dump failed.
        }
        const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
          method: 'POST', signal, body: extensions.payload, redirect: 'error',
          headers: {
            ...attributionHeaders(),
            'content-type': 'application/json', 'accept': 'text/event-stream',
            ...auth.headers,
            'anthropic-version': '2023-06-01',
            ...betas.length === 0 ? {} : { 'anthropic-beta': betas.join(',') },
            'x-deepseek-harness-user-id': this.dependencies.resolveUserId(),
            ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
            ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
          },
        })
        if (!response.ok) {
          const text = await response.text()
          let raw: unknown
          try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) {
            // HTTP status is authoritative when a gateway does not return JSON.
          }
          const detail = providerErrorDetail(raw)
          if (await files.retry(detail)) continue
          const failure = providerError(raw, response.status, response.headers)
          const message = files.errorMessage(response.status, failure.message, detail)
          throw new LlmError(message, failure.code, { ...failure.failure, cause: new Error(text) })
        }
        await extensions.accept()
        if (response.body === null) throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
        yield* translate(parseSse(response.body, activity), options.model)
        return
      }
    } catch (error) {
      if (auth.onRequestError !== undefined) {
        let mapped: unknown
        try { mapped = await auth.onRequestError(error) }
        catch (_credentialUpdateFailed) { throw error }
        throw mapped
      }
      throw error
    }
  }
}
