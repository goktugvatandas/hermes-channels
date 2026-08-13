import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { ActivityPanel } from '../../src/desktop/components/activity-panel'
import type { EventFrame } from '../../src/desktop/types'

afterEach(cleanup)

const states = ['queued', 'streaming', 'tool_started', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted']
const frames: EventFrame[] = states.map((type, index) => ({
  sequence: index + 1,
  type,
  channelId: 'channel-1',
  turnId: index < 4 ? 'turn-atlas' : `turn-${index}`,
  payload: {
    ...(index === 0 ? { profileId: 'atlas', reasons: ['default_responder'] } : {}),
    ...(type === 'tool_started' ? { name: 'shell', command: 'npm test' } : {}),
    ...(type === 'waiting_approval' ? { approvalId: 'approval-1', prompt: 'Allow shell?' } : {}),
  },
}))

describe('ActivityPanel', () => {
  it('renders one summarized item per turn and keeps raw activity in details', () => {
    render(<ActivityPanel api={{} as CrewApi} events={frames.slice(0, 3)} />)

    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.queryByText('streaming')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View activity details' }))
    expect(screen.getByText('shell')).not.toBeNull()
    expect(screen.getByText('default_responder')).not.toBeNull()
  })

  it('stops only Atlas turn and announces the acknowledgment', async () => {
    const cancelTurn = vi.fn(async () => ({}))
    render(<ActivityPanel api={{ cancelTurn } as unknown as CrewApi} events={frames.slice(0, 3)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop atlas' }))

    await waitFor(() => expect(cancelTurn).toHaveBeenCalledWith('turn-atlas'))
    expect(screen.getByRole('status').textContent).toContain('Stop requested for atlas')
  })

  it('rejects an approval without retrying or creating another turn', async () => {
    const resolveApproval = vi.fn(async () => ({}))
    const retryTurn = vi.fn(async () => ({}))
    render(<ActivityPanel api={{ resolveApproval, retryTurn } as unknown as CrewApi} events={frames.slice(0, 4)} />)
    fireEvent.click(screen.getByRole('button', { name: 'View activity details' }))
    const approval = screen.getByRole('group', { name: 'Approval required' })
    fireEvent.change(within(approval).getByLabelText('Approval note'), { target: { value: 'Not safe' } })
    fireEvent.click(within(approval).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith('approval-1', { decision: 'reject', note: 'Not safe' }))
    expect(retryTurn).not.toHaveBeenCalled()
  })
})

describe('ActivityPanel presentation', () => {
  it('uses stored display names and quotes the triggering message', async () => {
    const { PresentationContext } = await import('../../src/desktop/presentation')
    const events: EventFrame[] = [
      {
        sequence: 1, type: 'queued', channelId: 'channel-1', turnId: 'turn-1',
        payload: { profileId: 'atlas', triggerMessageId: 'm-9', triggerExcerpt: 'Please audit the login flow' },
      },
      { sequence: 2, type: 'completed', channelId: 'channel-1', turnId: 'turn-1', payload: {} },
    ]
    render(
      <PresentationContext.Provider value={{
        members: { atlas: { profileId: 'atlas', displayName: 'Seliel', role: 'Engineer', avatar: null, color: null, defaultProject: null, archived: false } },
        me: { displayName: 'You', avatar: null, color: null },
      }}>
        <ActivityPanel api={{} as CrewApi} events={events} />
      </PresentationContext.Provider>,
    )

    expect(screen.getByText('Seliel')).not.toBeNull()
    expect(screen.getByText('finished')).not.toBeNull()
    expect(screen.getByText('Please audit the login flow')).not.toBeNull()
  })
})

describe('ActivityPanel ordering', () => {
  it('lists newest turns first and pages older ones behind Load more', () => {
    const events: EventFrame[] = []
    for (let i = 0; i < 7; i += 1) {
      events.push({ sequence: i * 2 + 1, type: 'queued', channelId: 'c', turnId: `turn-${i}`, payload: { profileId: 'atlas', triggerExcerpt: `request ${i}` } })
      events.push({ sequence: i * 2 + 2, type: 'completed', channelId: 'c', turnId: `turn-${i}`, payload: {} })
    }
    render(<ActivityPanel api={{} as CrewApi} events={events} />)

    const articles = screen.getAllByRole('article')
    expect(articles).toHaveLength(5)
    expect(articles[0].textContent).toContain('request 6')
    expect(screen.queryByText('request 0')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
    expect(screen.getAllByRole('article')).toHaveLength(7)
    expect(screen.getByText('request 0')).not.toBeNull()
  })
})

describe('tool pairing', () => {
  it('pairs started/finished frames and settles tools of terminal turns', async () => {
    const { pairToolEvents } = await import('../../src/desktop/conversation-model')
    const events: EventFrame[] = [
      { sequence: 1, type: 'tool_started', channelId: 'c', turnId: 't', payload: { name: 'shell', command: 'npm test' } },
      { sequence: 2, type: 'tool_started', channelId: 'c', turnId: 't', payload: { name: 'read' } },
      { sequence: 3, type: 'tool_finished', channelId: 'c', turnId: 't', payload: { name: 'shell', exitCode: 0 } },
    ]
    const paired = pairToolEvents(events)
    expect(paired).toHaveLength(2)
    expect(paired[0].finished?.sequence).toBe(3)
    expect(paired[1].finished).toBeUndefined()

    // A terminal turn renders every tool as finished, even unpaired ones.
    const { ToolActivity } = await import('../../src/desktop/components/tool-activity')
    render(<ToolActivity invocation={paired[1]} turnTerminal />)
    expect(screen.getByText('finished')).not.toBeNull()
    expect(screen.queryByText('running…')).toBeNull()
  })
})
