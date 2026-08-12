import type { IntentEnvelope, MessageIntent } from './types'

const EXACT_MARKER = /<!-- hermes-crew:intent (\{[^\r\n]*\}) -->/g
const ANY_MARKER = /<!--\s*hermes-crew:intent\b[^\r\n]*?-->/g
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
])
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'intent',
  'recipients',
  'replyExpected',
  'replyBudget',
  'correlationId',
  'summary',
])

const fallbackEnvelope = (): IntentEnvelope => ({
  schemaVersion: 1,
  intent: 'inform',
  recipients: [],
  replyExpected: false,
  replyBudget: 0,
  correlationId: null,
  summary: '',
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
  }
}

export function parseIntentMarker(text: string): {
  visibleText: string
  envelope: IntentEnvelope
} {
  const visibleText = text.replace(ANY_MARKER, '').trim()
  const matches = [...text.matchAll(EXACT_MARKER)]
  if (matches.length !== 1) return { visibleText, envelope: fallbackEnvelope() }

  const match = matches[0]
  const matchEnd = (match.index ?? 0) + match[0].length
  const payload = match[1]
  if (text.slice(matchEnd).trim() || new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    return { visibleText, envelope: fallbackEnvelope() }
  }

  try {
    const envelope = validatedEnvelope(JSON.parse(payload))
    return { visibleText, envelope: envelope ?? fallbackEnvelope() }
  } catch {
    return { visibleText, envelope: fallbackEnvelope() }
  }
}
