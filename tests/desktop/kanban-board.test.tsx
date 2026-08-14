import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import { KanbanBoard } from '../../src/desktop/components/kanban-board'
import type { KanbanCard, KanbanSnapshot } from '../../src/desktop/types'

afterEach(cleanup)

function card(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    id: 'task-1',
    title: 'Ship the bridge',
    body: null,
    status: 'ready',
    assignee: null,
    priority: 0,
    createdBy: 'channels',
    projectId: null,
    result: null,
    blockKind: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function snapshot(cards: KanbanCard[]): KanbanSnapshot {
  return {
    bound: true,
    boardSlug: 'channel-general',
    boardName: '#general',
    statuses: ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'],
    cards,
  }
}

function apiStub(overrides: Partial<CrewApi>): CrewApi {
  return {
    channelKanban: vi.fn().mockResolvedValue(snapshot([])),
    listKanbanBoards: vi.fn().mockResolvedValue([]),
    rebindKanbanBoard: vi.fn(),
    assignKanbanCard: vi.fn(),
    editKanbanCard: vi.fn(),
    createKanbanCard: vi.fn(),
    getKanbanCard: vi.fn(),
    completeKanbanCard: vi.fn(),
    blockKanbanCard: vi.fn(),
    unblockKanbanCard: vi.fn(),
    commentKanbanCard: vi.fn(),
    deleteKanbanCard: vi.fn(),
    ...overrides,
  } as unknown as CrewApi
}

describe('KanbanBoard', () => {
  it('renders cards grouped into lanes', async () => {
    const api = apiStub({
      channelKanban: vi.fn().mockResolvedValue(
        snapshot([
          card({ id: 'a', title: 'In ready lane' }),
          card({ id: 'b', title: 'Being worked', status: 'running' }),
          card({ id: 'c', title: 'Shipped', status: 'done' }),
        ]),
      ),
    })
    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() => expect(screen.getByText('In ready lane')).toBeTruthy())
    expect(screen.getByText('Being worked')).toBeTruthy()
    expect(screen.getByText('Shipped')).toBeTruthy()
    expect(screen.getByLabelText('Ready')).toBeTruthy()
    // Every host lane is always on the board, empty or not.
    for (const lane of ['Triage', 'To Do', 'Scheduled', 'Blocked', 'Review']) {
      expect(screen.getByLabelText(lane)).toBeTruthy()
    }
  })

  it('files a new card through the API and refreshes', async () => {
    const created = card({ id: 'new', title: 'File taxes' })
    const channelKanban = vi.fn()
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValue(snapshot([created]))
    const createKanbanCard = vi.fn().mockResolvedValue(created)
    const api = apiStub({ channelKanban, createKanbanCard })

    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() => expect(channelKanban).toHaveBeenCalled())

    fireEvent.click(screen.getByText('＋ New card'))
    fireEvent.change(screen.getByLabelText('Card title'), {
      target: { value: 'File taxes' },
    })
    fireEvent.change(screen.getByLabelText('Card description'), {
      target: { value: 'Q3 deadline' },
    })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(screen.getByText('File taxes')).toBeTruthy())
    expect(createKanbanCard).toHaveBeenCalledWith('channel-1', { title: 'File taxes', body: 'Q3 deadline' })
  })

  it('opens card details and completes the card', async () => {
    const ready = card({ id: 'a', title: 'Close me' })
    const api = apiStub({
      channelKanban: vi.fn().mockResolvedValue(snapshot([ready])),
      getKanbanCard: vi.fn().mockResolvedValue({ ...ready, comments: [] }),
      completeKanbanCard: vi.fn().mockResolvedValue({ ...ready, status: 'done' }),
    })
    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() => expect(screen.getByText('Close me')).toBeTruthy())

    fireEvent.click(screen.getByText('Close me'))
    await waitFor(() => expect(screen.getByLabelText('Card details')).toBeTruthy())

    fireEvent.click(screen.getByText('Complete'))
    await waitFor(() => expect(api.completeKanbanCard).toHaveBeenCalledWith('channel-1', 'a'))
  })

  it('surfaces board errors instead of a blank pane', async () => {
    const api = apiStub({
      channelKanban: vi.fn().mockRejectedValue(new Error('host kanban store unavailable')),
    })
    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('host kanban store unavailable'),
    )
  })
})


describe('KanbanBoard unbound state', () => {
  it('offers create and connect instead of silently making a board', async () => {
    const rebindKanbanBoard = vi.fn().mockResolvedValue(snapshot([]))
    const api = apiStub({
      channelKanban: vi.fn().mockResolvedValue({
        bound: false,
        suggestedSlug: 'channel-general',
        boards: [{ slug: 'my-old-board', name: 'My Old Board' }],
      }),
      rebindKanbanBoard,
    })
    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() => expect(screen.getByText('No board connected')).toBeTruthy())
    expect(screen.getByText(/Create board/)).toBeTruthy()

    fireEvent.click(screen.getByText(/Create board/))
    await waitFor(() => expect(rebindKanbanBoard).toHaveBeenCalledWith('channel-1', 'channel-general'))
  })
})


describe('KanbanBoard editing', () => {
  it('edits title, body, and priority from the details modal', async () => {
    const ready = card({ id: 'a', title: 'Old title', body: 'old body' })
    const editKanbanCard = vi.fn().mockResolvedValue({ ...ready, title: 'New title', body: 'new body', priority: 3 })
    const api = apiStub({
      channelKanban: vi.fn().mockResolvedValue(snapshot([ready])),
      getKanbanCard: vi.fn().mockResolvedValue({ ...ready, comments: [] }),
      editKanbanCard,
    })
    render(<KanbanBoard api={api} channelId="channel-1" />)
    await waitFor(() => expect(screen.getByText('Old title')).toBeTruthy())

    fireEvent.click(screen.getByText('Old title'))
    await waitFor(() => expect(screen.getByLabelText('Card details')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Edit card'))
    fireEvent.change(screen.getByLabelText('Edit title'), { target: { value: 'New title' } })
    fireEvent.change(screen.getByLabelText('Edit description'), { target: { value: 'new body' } })
    fireEvent.change(screen.getByLabelText('Edit priority'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(editKanbanCard).toHaveBeenCalledWith('channel-1', 'a', {
      title: 'New title', body: 'new body', priority: 3,
    }))
  })
})


describe('KanbanBoard lane collapse', () => {
  it('collapses occupied lanes to a rail and expands them back', async () => {
    const api = apiStub({
      channelKanban: vi.fn().mockResolvedValue(snapshot([card({ id: 'a', title: 'Visible card' })])),
    })
    render(<KanbanBoard api={api} channelId="channel-collapse-test" />)
    await waitFor(() => expect(screen.getByText('Visible card')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Minimize Ready'))
    expect(screen.queryByText('Visible card')).toBeNull()

    fireEvent.click(screen.getByLabelText('Expand Ready (1)'))
    await waitFor(() => expect(screen.getByText('Visible card')).toBeTruthy())
  })

  it('rests empty lanes as rails by default', async () => {
    const api = apiStub({ channelKanban: vi.fn().mockResolvedValue(snapshot([])) })
    render(<KanbanBoard api={api} channelId="channel-empty-test" />)
    await waitFor(() => expect(screen.getByLabelText('Expand Ready (0)')).toBeTruthy())
    expect(screen.getByLabelText('Expand Triage (0)')).toBeTruthy()
  })
})
