import { describe, expect, it } from 'vitest'

import { normalizeGatewayEvent } from '../../src/desktop/event-normalizer'
import { parseIntentMarker } from '../../src/desktop/intent-marker'

describe('gateway event normalization', () => {
  it('turns Hermes tool events into canonical Crew activity', () => {
    expect(
      normalizeGatewayEvent({
        type: 'tool.start',
        session_id: 'runtime-1',
        payload: {
          name: 'shell',
          tool_id: 'tool-1',
          nested_value: { request_id: 'request-1' },
        },
      }),
    ).toEqual({
      type: 'tool_started',
      payload: {
        gatewayType: 'tool.start',
        name: 'shell',
        nestedValue: { requestId: 'request-1' },
        toolId: 'tool-1',
      },
    })
  })

  it('normalizes approvals and ignores terminal completion frames', () => {
    expect(
      normalizeGatewayEvent({
        type: 'approval.request',
        session_id: 'runtime-1',
        payload: { request_id: 'approval-1', prompt: 'Allow?' },
      }),
    ).toEqual({
      type: 'approval_request',
      payload: {
        gatewayType: 'approval.request',
        prompt: 'Allow?',
        requestId: 'approval-1',
      },
    })
    expect(
      normalizeGatewayEvent({
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Done' },
      }),
    ).toBeNull()
  })
})

describe('hidden intent marker parsing', () => {
  it('returns visible prose and a valid final routing envelope', () => {
    const output = parseIntentMarker(
      'Ready.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"review_request","recipients":["critic"],"replyExpected":true,"replyBudget":1} -->',
    )

    expect(output).toEqual({
      visibleText: 'Ready.',
      envelope: {
        schemaVersion: 1,
        intent: 'review_request',
        recipients: ['critic'],
        replyExpected: true,
        replyBudget: 1,
        correlationId: null,
        summary: '',
      },
    })
  })

  it('strips conflicting markers and safely falls back to inform', () => {
    const output = parseIntentMarker(
      'Draft.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"handoff","recipients":["atlas"],"replyExpected":true} -->\nFinal.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"inform"} -->',
    )

    expect(output.visibleText).toBe('Draft.\n\nFinal.')
    expect(output.envelope).toEqual({
      schemaVersion: 1,
      intent: 'inform',
      recipients: [],
      replyExpected: false,
      replyBudget: 0,
      correlationId: null,
      summary: '',
    })
  })
})
