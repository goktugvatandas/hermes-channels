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
  it('renders every durable state and groups tool details under the turn', () => {
    render(<ActivityPanel api={{} as CrewApi} events={frames} />)

    for (const state of states) expect(screen.getAllByText(state).length).toBeGreaterThan(0)
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
    const approval = screen.getByRole('group', { name: 'Approval required' })
    fireEvent.change(within(approval).getByLabelText('Approval note'), { target: { value: 'Not safe' } })
    fireEvent.click(within(approval).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith('approval-1', { decision: 'reject', note: 'Not safe' }))
    expect(retryTurn).not.toHaveBeenCalled()
  })
})
