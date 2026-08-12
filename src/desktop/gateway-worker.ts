import { host, type PluginRest } from '@hermes/plugin-sdk'

import { normalizeGatewayEvent, type NormalizedGatewayEvent } from './event-normalizer'
import { parseIntentMarker } from './intent-marker'
import type { DispatchClaim, EventFrame, RpcEvent } from './types'

const CLAIM_INTERVAL_MS = 2_000
const EVENT_FLUSH_MS = 100
const EVENT_BATCH_SIZE = 50
const WORKER_STORAGE_KEY = 'hermes-crew.worker-id'

interface SessionCreateResult {
  session_id: string
  stored_session_id?: string | null
}

interface OneShotResult {
  text?: string
}

type GatewayRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

interface GatewayWorkerOptions {
  rest: PluginRest
  socket: (path: string, onMessage: (data: unknown) => void) => (() => void) | void
  request?: GatewayRequest
  onEvent?: (type: string, listener: (event: RpcEvent) => void) => () => void
  gatewayState?: { get(): string }
  workerId?: string
}

interface QueuedEvent extends NormalizedGatewayEvent {
  turnId: string
}

function stableWorkerId(): string {
  try {
    const stored = window.sessionStorage.getItem(WORKER_STORAGE_KEY)
    if (stored) return stored
    const workerId = crypto.randomUUID()
    window.sessionStorage.setItem(WORKER_STORAGE_KEY, workerId)
    return workerId
  } catch {
    return crypto.randomUUID()
  }
}

function sessionCreateParams(claim: DispatchClaim): Record<string, unknown> {
  return {
    cols: 96,
    source: 'desktop',
    ...(claim.cwd ? { cwd: claim.cwd } : {}),
    ...(claim.profileId ? { profile: claim.profileId } : {}),
    ...(claim.model
      ? {
          model: claim.model,
          ...(claim.provider ? { provider: claim.provider } : {}),
        }
      : {}),
    ...(claim.reasoningEffort
      ? { reasoning_effort: claim.reasoningEffort }
      : {}),
    fast: false,
  }
}

function dispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'Hermes dispatch failed').slice(0, 500)
}

function eventFrame(value: unknown): EventFrame | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Partial<EventFrame>
  if (
    typeof frame.sequence !== 'number' ||
    typeof frame.type !== 'string' ||
    typeof frame.channelId !== 'string'
  ) {
    return null
  }
  return {
    sequence: frame.sequence,
    type: frame.type,
    channelId: frame.channelId,
    turnId: typeof frame.turnId === 'string' ? frame.turnId : null,
    payload:
      frame.payload && typeof frame.payload === 'object'
        ? frame.payload
        : {},
  }
}

export class GatewayWorker {
  private readonly rest: PluginRest
  private readonly socket: GatewayWorkerOptions['socket']
  private readonly request: GatewayRequest
  private readonly onEvent: NonNullable<GatewayWorkerOptions['onEvent']>
  private readonly gatewayState: NonNullable<GatewayWorkerOptions['gatewayState']>
  private readonly workerId: string
  private readonly sessionToTurn = new Map<string, string>()
  private readonly turnToSession = new Map<string, string>()
  private readonly assistantText = new Map<string, string>()
  private eventQueue: QueuedEvent[] = []
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private eventDisposer: (() => void) | null = null
  private socketDisposer: (() => void) | null = null
  private eventCursor = 0
  private ticking = false
  private flushing: Promise<void> | null = null

  constructor(options: GatewayWorkerOptions) {
    this.rest = options.rest
    this.socket = options.socket
    this.request = options.request ?? (host.request as GatewayRequest)
    this.onEvent = options.onEvent ?? host.onEvent
    this.gatewayState = options.gatewayState ?? host.state.gateway
    this.workerId = options.workerId ?? stableWorkerId()
  }

  start(): () => void {
    this.eventDisposer = this.onEvent('*', (event) => {
      void this.handleGatewayEvent(event).catch((error: unknown) => {
        console.error('[hermes-crew] gateway event failed', error)
      })
    })
    const socketDisposer = this.socket('/events', (data) => {
      void this.handleCrewFrame(data)
        .then(() => this.tick())
        .catch((error: unknown) => {
          console.error('[hermes-crew] socket event failed', error)
        })
    })
    this.socketDisposer = typeof socketDisposer === 'function' ? socketDisposer : null
    void this.tick()
    this.interval = setInterval(() => void this.tick(), CLAIM_INTERVAL_MS)

    return () => this.dispose()
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.interval = null
    this.eventTimer = null
    this.eventDisposer?.()
    this.socketDisposer?.()
    this.eventDisposer = null
    this.socketDisposer = null
  }

  async claimOnce(): Promise<boolean> {
    if (this.gatewayState.get() !== 'open') return false
    const claim = await this.rest<DispatchClaim | undefined>('/dispatch/claim', {
      method: 'POST',
      body: { workerId: this.workerId },
    })
    if (!claim) return false
    let runtimeSessionId: string | null = null
    try {
      const created = (await this.request(
        'session.create',
        sessionCreateParams(claim),
      )) as SessionCreateResult
      runtimeSessionId = created.session_id
      await this.rest(`/dispatch/${encodeURIComponent(claim.id)}/session`, {
        method: 'POST',
        body: {
          runtimeSessionId: created.session_id,
          storedSessionId: created.stored_session_id ?? null,
        },
      })
      this.bind(claim.id, created.session_id)

      if (claim.kind === 'classification') {
        const result = (await this.request('llm.oneshot', {
          session_id: created.session_id,
          instructions: claim.instructions ?? '',
          input: claim.input ?? '',
          task: 'hermes_crew_classifier',
          max_tokens: claim.maxTokens,
          temperature: claim.temperature,
        })) as OneShotResult
        await this.rest(`/dispatch/${encodeURIComponent(claim.id)}/classification`, {
          method: 'POST',
          body: { rawResult: result.text ?? '' },
        })
        this.unbind(claim.id, created.session_id)
        return true
      }

      await this.request('prompt.submit', {
        session_id: created.session_id,
        text: claim.context,
      })
      return true
    } catch (error) {
      if (runtimeSessionId) this.unbind(claim.id, runtimeSessionId)
      await this.rest(`/dispatch/${encodeURIComponent(claim.id)}/fail`, {
        method: 'POST',
        body: { error: dispatchError(error) },
      })
      return true
    }
  }

  async handleGatewayEvent(event: RpcEvent): Promise<void> {
    const sessionId = event.session_id
    if (!sessionId) return
    const turnId = this.sessionToTurn.get(sessionId)
    if (!turnId) return

    if (event.type === 'message.delta') {
      const text = this.gatewayText(event.payload)
      if (text) this.assistantText.set(turnId, (this.assistantText.get(turnId) ?? '') + text)
    }

    if (event.type === 'message.complete') {
      await this.flushAllEvents()
      const finalText = this.gatewayText(event.payload) || this.assistantText.get(turnId) || ''
      const parsed = parseIntentMarker(finalText)
      await this.rest(`/dispatch/${encodeURIComponent(turnId)}/complete`, {
        method: 'POST',
        body: parsed,
      })
      this.unbind(turnId, sessionId)
      return
    }

    const normalized = normalizeGatewayEvent(event)
    if (normalized) this.queueEvent({ ...normalized, turnId })
  }

  async handleCrewFrame(value: unknown): Promise<void> {
    const frame = eventFrame(value)
    if (!frame) return
    this.eventCursor = Math.max(this.eventCursor, frame.sequence)
    if (frame.type !== 'cancelled' || !frame.turnId) return
    const sessionId = this.turnToSession.get(frame.turnId)
    if (!sessionId) return
    await this.request('session.interrupt', { session_id: sessionId })
    this.unbind(frame.turnId, sessionId)
  }

  private bind(turnId: string, sessionId: string): void {
    this.sessionToTurn.set(sessionId, turnId)
    this.turnToSession.set(turnId, sessionId)
  }

  private unbind(turnId: string, sessionId: string): void {
    this.sessionToTurn.delete(sessionId)
    this.turnToSession.delete(turnId)
    this.assistantText.delete(turnId)
  }

  private gatewayText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    const record = payload as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    return typeof record.rendered === 'string' ? record.rendered : ''
  }

  private queueEvent(event: QueuedEvent): void {
    this.eventQueue.push(event)
    if (this.eventQueue.length >= EVENT_BATCH_SIZE) {
      void this.flushEventBatch()
      return
    }
    if (!this.eventTimer) {
      this.eventTimer = setTimeout(() => {
        this.eventTimer = null
        void this.flushEventBatch()
      }, EVENT_FLUSH_MS)
    }
  }

  private async flushEventBatch(): Promise<void> {
    if (this.flushing) return this.flushing
    const batch = this.eventQueue.splice(0, EVENT_BATCH_SIZE)
    if (!batch.length) return
    this.flushing = (async () => {
      for (const event of batch) {
        await this.rest(`/dispatch/${encodeURIComponent(event.turnId)}/events`, {
          method: 'POST',
          body: { type: event.type, payload: event.payload },
        })
      }
    })()
    try {
      await this.flushing
    } finally {
      this.flushing = null
      if (this.eventQueue.length && !this.eventTimer) {
        this.eventTimer = setTimeout(() => {
          this.eventTimer = null
          void this.flushEventBatch()
        }, EVENT_FLUSH_MS)
      }
    }
  }

  private async flushAllEvents(): Promise<void> {
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.eventTimer = null
    if (this.flushing) await this.flushing
    while (this.eventQueue.length) await this.flushEventBatch()
  }

  private async pollEvents(): Promise<void> {
    const frames = await this.rest<unknown[]>(`/events?after=${this.eventCursor}`)
    if (!Array.isArray(frames)) return
    for (const frame of frames) await this.handleCrewFrame(frame)
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.gatewayState.get() !== 'open') return
    this.ticking = true
    try {
      await this.pollEvents()
      await this.claimOnce()
    } catch (error) {
      console.error('[hermes-crew] dispatch tick failed', error)
    } finally {
      this.ticking = false
    }
  }
}
