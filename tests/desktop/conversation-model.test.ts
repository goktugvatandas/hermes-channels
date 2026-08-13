import { describe, expect, it } from 'vitest'

import { groupMessages, summarizeTurns, turnStateLabel } from '../../src/desktop/conversation-model'
import type { CrewMessage, EventFrame } from '../../src/desktop/types'

function message(overrides: Partial<CrewMessage>): CrewMessage {
  return {
    id: 'message',
    channelId: 'channel-1',
    rootMessageId: null,
    authorType: 'agent',
    authorProfileId: 'atlas',
    content: 'Message',
    mentions: [],
    project: null,
    modelLabel: null,
    createdAt: 1,
    ...overrides,
  }
}

function frame(
  sequence: number,
  type: string,
  turnId: string,
  payload: Record<string, unknown> = {},
): EventFrame {
  return {
    sequence,
    type,
    turnId,
    payload: { profileId: 'atlas', ...payload },
    channelId: 'channel-1',
  }
}

describe('conversation presentation', () => {
  it('groups consecutive messages from the same author within five minutes', () => {
    const result = groupMessages([
      message({ id: 'one', createdAt: 1_000 }),
      message({ id: 'two', createdAt: 60_000 }),
      message({ id: 'three', authorProfileId: 'critic', createdAt: 61_000 }),
      message({ id: 'four', authorProfileId: 'critic', createdAt: 400_001 }),
    ])

    expect(result.map((item) => item.startsGroup)).toEqual([true, false, true, true])
  })

  it('keeps delivery state outside persisted message data', () => {
    const [result] = groupMessages(
      [message({ id: 'local:one', authorType: 'user', authorProfileId: null })],
      { 'local:one': 'failed' },
    )

    expect(result.deliveryState).toBe('failed')
    expect('deliveryState' in result.message).toBe(false)
  })

  it('collapses repeated streaming frames into one active turn', () => {
    const [turn] = summarizeTurns([
      frame(1, 'queued', 'turn-atlas'),
      frame(2, 'streaming', 'turn-atlas'),
      frame(3, 'streaming', 'turn-atlas'),
    ])

    expect(turn).toMatchObject({
      turnId: 'turn-atlas',
      profileId: 'atlas',
      state: 'streaming',
      terminal: false,
    })
    expect(turnStateLabel(turn.state)).toBe('is working…')
    expect(turn.events).toHaveLength(3)
  })

  it('captures a persisted message id and terminal state labels', () => {
    const turns = summarizeTurns([
      frame(4, 'completed', 'turn-atlas', { messageId: 'message-agent' }),
      frame(5, 'failed', 'turn-critic', { profileId: 'critic', error: 'Offline' }),
    ])

    expect(turns[0]).toMatchObject({
      messageId: 'message-agent',
      terminal: true,
    })
    expect(turnStateLabel(turns[0].state)).toBe('finished')
    expect(turns[1]).toMatchObject({
      profileId: 'critic',
      terminal: true,
    })
    expect(turnStateLabel(turns[1].state)).toBe("couldn't complete this request")
  })
})
