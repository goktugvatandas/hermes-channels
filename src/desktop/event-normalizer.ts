import type { RpcEvent } from './types'

export interface NormalizedGatewayEvent {
  type: string
  payload: Record<string, unknown>
}

const EVENT_TYPES: Record<string, string | null> = {
  'session.info': 'session_info',
  'message.start': 'streaming',
  'message.delta': 'streaming',
  'message.complete': null,
  'thinking.delta': 'streaming',
  'reasoning.delta': 'streaming',
  'status.update': 'status_update',
  'tool.start': 'tool_started',
  'tool.progress': 'tool_progress',
  'tool.complete': 'tool_finished',
  'clarify.request': 'clarify_request',
  'approval.request': 'approval_request',
  error: 'failed',
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function camelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      camelKey(key),
      camelValue(nested),
    ]),
  )
}

export function normalizeGatewayEvent(
  event: RpcEvent,
): NormalizedGatewayEvent | null {
  const type = EVENT_TYPES[event.type]
  if (type === undefined || type === null) return null
  const payload = camelValue(event.payload)
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : payload === undefined
        ? {}
        : { value: payload }
  return {
    type,
    payload: { ...record, gatewayType: event.type },
  }
}
