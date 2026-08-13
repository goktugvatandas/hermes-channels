import type { IntentEnvelope, MessageIntent } from './types'

// Two accepted forms. The canonical one is plain text ([[…]]) because the
// Hermes gateway sanitizes HTML comments out of message frames — an
// HTML-comment-only contract meant workers never saw the envelope and every
// handoff silently downgraded to the default. The comment form stays
// parseable for older content. Both are tolerant of whitespace and
// pretty-printed JSON.
const EXACT_MARKER = /(?:<!--|\[\[)\s*hermes-crew:intent\s+(\{[\s\S]*?\})\s*(?:-->|\]\])/g
const ANY_MARKER = /(?:<!--\s*hermes-crew:intent\b[^\r\n]*?-->|\[\[\s*hermes-crew:intent\b[^\r\n]*?\]\])/g
const MAX_PAYLOAD_BYTES = 4096
const INTENTS = new Set<MessageIntent>([
  'inform',
  'result',
  'reply_required',
  'question',
  'handoff',
  'review_request',
  'blocked',
  'approval_request',
])
const REPLY_INTENTS = new Set<MessageIntent>([
  'reply_required',
  'handoff',
  'review_request',
  'question',
])
// Scheduling intents by merge priority (strongest first).
const SCHEDULING_INTENTS: MessageIntent[] = ['handoff', 'review_request', 'reply_required', 'question']
// `placement` was missing here while the response contract instructed
// agents to send it — every contract-compliant envelope failed validation.
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'intent',
  'recipients',
  'replyExpected',
  'replyBudget',
  'correlationId',
  'summary',
  'placement',
])
const PLACEMENTS = new Set(['auto', 'thread', 'channel'])

const fallbackEnvelope = (): IntentEnvelope => ({
  schemaVersion: 1,
  intent: 'inform',
  recipients: [],
  replyExpected: false,
  replyBudget: 0,
  correlationId: null,
  summary: '',
  placement: 'auto',
})

function validatedEnvelope(value: unknown): IntentEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !ENVELOPE_KEYS.has(key))) return null

  const schemaVersion = raw.schemaVersion ?? 1
  const intent = raw.intent ?? 'inform'
  const recipients = raw.recipients ?? []
  const replyExpected = raw.replyExpected ?? false
  const replyBudget = raw.replyBudget ?? 0
  const correlationId = raw.correlationId ?? null
  const summary = raw.summary ?? ''
  const placement = raw.placement ?? 'auto'

  if (schemaVersion !== 1 || typeof intent !== 'string' || !INTENTS.has(intent as MessageIntent)) {
    return null
  }
  if (
    !Array.isArray(recipients) ||
    recipients.some((recipient) => typeof recipient !== 'string' || !recipient.trim())
  ) {
    return null
  }
  const cleanedRecipients = recipients.map((recipient) => (recipient as string).trim())
  if (new Set(cleanedRecipients).size !== cleanedRecipients.length) return null
  if (typeof replyExpected !== 'boolean') return null
  if (!Number.isInteger(replyBudget) || (replyBudget as number) < 0 || (replyBudget as number) > 2) {
    return null
  }
  if (correlationId !== null && typeof correlationId !== 'string') return null
  if (typeof summary !== 'string' || summary.length > 500) return null
  if (typeof placement !== 'string' || !PLACEMENTS.has(placement)) return null

  const typedIntent = intent as MessageIntent
  if (
    REPLY_INTENTS.has(typedIntent) &&
    (!replyExpected || cleanedRecipients.length === 0)
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    intent: typedIntent,
    recipients: cleanedRecipients,
    replyExpected,
    replyBudget: replyBudget as number,
    correlationId,
    summary,
    placement: placement as IntentEnvelope['placement'],
  }
}

/**
 * Collapse several markers into one envelope: recipients union, strongest
 * scheduling intent, max budget, first explicit placement. Models routinely
 * emit one marker per delegation plus a wrap-up "inform"; taking only one
 * (or none) silently dropped real handoffs.
 */
function mergeEnvelopes(envelopes: IntentEnvelope[]): IntentEnvelope {
  if (envelopes.length === 1) return envelopes[0]
  const intent = SCHEDULING_INTENTS.find((name) => envelopes.some((e) => e.intent === name))
    ?? envelopes[envelopes.length - 1].intent
  const scheduling = SCHEDULING_INTENTS.includes(intent)
  const recipients: string[] = []
  for (const envelope of envelopes) {
    for (const recipient of envelope.recipients) {
      if (!recipients.includes(recipient)) recipients.push(recipient)
    }
  }
  return {
    schemaVersion: 1,
    intent,
    recipients,
    replyExpected: envelopes.some((e) => e.replyExpected) || scheduling,
    replyBudget: Math.max(...envelopes.map((e) => e.replyBudget), scheduling ? 1 : 0),
    correlationId: envelopes.find((e) => e.correlationId)?.correlationId ?? null,
    summary: [...envelopes].reverse().find((e) => e.summary)?.summary ?? '',
    placement: envelopes.find((e) => e.placement !== 'auto')?.placement ?? 'auto',
  }
}

/** Remove hidden crew intent markers from displayable text. */
export function stripIntentMarkers(text: string): string {
  return text.replace(ANY_MARKER, '').trim()
}

export function hasIntentMarker(text: string): boolean {
  ANY_MARKER.lastIndex = 0
  return ANY_MARKER.test(text)
}

export function parseIntentMarker(text: string): {
  visibleText: string
  envelope: IntentEnvelope
} {
  const visibleText = text.replace(ANY_MARKER, '').trim()
  const envelopes: IntentEnvelope[] = []
  for (const match of text.matchAll(EXACT_MARKER)) {
    const payload = match[1]
    if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) continue
    try {
      const envelope = validatedEnvelope(JSON.parse(payload))
      if (envelope) envelopes.push(envelope)
    } catch {
      continue
    }
  }
  if (!envelopes.length) return { visibleText, envelope: fallbackEnvelope() }
  return { visibleText, envelope: mergeEnvelopes(envelopes) }
}
