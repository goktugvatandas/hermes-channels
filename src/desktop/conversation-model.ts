import type { CrewMessage, EventFrame } from './types'

const GROUP_WINDOW_MS = 5 * 60 * 1_000
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
// The journal also records informational frames (session_info, routing_decision,
// journal markers) after a turn settles; only these types describe turn state.
const STATE_EVENT_TYPES = new Set([
  'queued',
  'claimed',
  'started',
  'running',
  'streaming',
  'tool_started',
  'tool_finished',
  'waiting_approval',
  'approval_request',
  'approval_resolved',
  ...TERMINAL_STATES,
])

export type DeliveryState = 'sent' | 'sending' | 'failed'

export interface PresentedMessage {
  message: CrewMessage
  startsGroup: boolean
  deliveryState: DeliveryState
}

export interface TurnSummary {
  turnId: string
  profileId: string
  state: string
  events: EventFrame[]
  messageId: string | null
  terminal: boolean
  /** Hermes session behind this turn, for hands-on jumps into the agent. */
  sessionId: string | null
  /** The message this turn answers, when the journal recorded it. */
  triggerMessageId: string | null
  triggerExcerpt: string | null
}

/** Canonical presentation name for a profile id ('agent' means the crew). */
export function displayName(profileId: string): string {
  if (profileId === 'agent') return 'Crew'
  return profileId ? `${profileId[0].toUpperCase()}${profileId.slice(1)}` : 'Crew'
}

/** Name-free state phrasing so callers can prepend any presentation name. */
export function turnStateLabel(state: string): string {
  if (state === 'completed') return 'finished'
  if (state === 'failed') return "couldn't complete this request"
  if (state === 'cancelled') return 'was stopped'
  if (state === 'interrupted') return 'was interrupted'
  if (state === 'waiting_approval' || state === 'approval_request') return 'needs approval'
  return 'is working…'
}

export interface ToolInvocation {
  started: EventFrame
  finished?: EventFrame
}

/**
 * One entry per tool call: `tool_started` frames paired with their
 * `tool_finished` (by call id when present, else by name, else first open).
 * Rendering the raw frames showed every tool twice — once forever "running".
 */
export function pairToolEvents(events: EventFrame[]): ToolInvocation[] {
  const callId = (event: EventFrame) => event.payload.toolCallId ?? event.payload.callId ?? null
  const toolName = (event: EventFrame) => String(event.payload.name || event.payload.toolName || '')
  const invocations: ToolInvocation[] = []
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === 'tool_started') {
      invocations.push({ started: event })
    } else if (event.type === 'tool_finished') {
      const id = callId(event)
      const open = invocations.find((invocation) => !invocation.finished && id !== null && callId(invocation.started) === id)
        || invocations.find((invocation) => !invocation.finished && toolName(invocation.started) === toolName(event))
        || invocations.find((invocation) => !invocation.finished)
      if (open) open.finished = event
      else invocations.push({ started: event, finished: event })
    }
  }
  return invocations
}

export function groupMessages(
  messages: CrewMessage[],
  deliveryById: Record<string, DeliveryState> = {},
): PresentedMessage[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    const sameAuthor = Boolean(
      previous &&
      previous.authorType === message.authorType &&
      previous.authorProfileId === message.authorProfileId,
    )
    return {
      message,
      startsGroup: !sameAuthor || message.createdAt - previous.createdAt > GROUP_WINDOW_MS,
      deliveryState: deliveryById[message.id] || 'sent',
    }
  })
}

export function summarizeTurns(events: EventFrame[]): TurnSummary[] {
  const groups = new Map<string, EventFrame[]>()
  for (const event of events) {
    if (!event.turnId) continue
    const current = groups.get(event.turnId) || []
    current.push(event)
    groups.set(event.turnId, current)
  }

  return [...groups.entries()].map(([turnId, frames]) => {
    const ordered = [...frames].sort((left, right) => left.sequence - right.sequence)
    const stateEvents = ordered.filter((event) => STATE_EVENT_TYPES.has(event.type))
    const latest = stateEvents[stateEvents.length - 1] || ordered[ordered.length - 1]
    const profileId = ordered
      .map((event) => event.payload.profileId)
      .find((value): value is string => typeof value === 'string' && value.length > 0) || 'agent'
    const messageId = [...ordered]
      .reverse()
      .map((event) => event.payload.messageId)
      .find((value): value is string => typeof value === 'string' && value.length > 0) || null
    const sessionId = ordered
      .map((event) => event.payload.storedSessionId || event.payload.runtimeSessionId)
      .find((value): value is string => typeof value === 'string' && value.length > 0) || null
    const triggerMessageId = ordered
      .map((event) => event.payload.triggerMessageId)
      .find((value): value is string => typeof value === 'string' && value.length > 0) || null
    const triggerExcerpt = ordered
      .map((event) => event.payload.triggerExcerpt)
      .find((value): value is string => typeof value === 'string' && value.length > 0) || null
    return {
      turnId,
      profileId,
      state: latest.type,
      events: ordered,
      messageId,
      terminal: TERMINAL_STATES.has(latest.type),
      sessionId,
      triggerMessageId,
      triggerExcerpt,
    }
  })
}
