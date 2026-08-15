import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import type { ChannelNavigationController } from '../../src/desktop/channel-navigation'
import { CrewPane } from '../../src/desktop/components/crew-pane'
import type { ChannelSections, CrewChannel } from '../../src/desktop/types'

afterEach(cleanup)

function channel(id: string, name = id): CrewChannel {
  return {
    id,
    name,
    purpose: '',
    topic: '',
    defaultResponderProfile: null,
    defaultProject: null,
    allowedProjects: [],
    routingRules: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Minimal stand-in for ChannelNavigationController: a channel list the test
 * mutates plus the subscribe hook the pane re-renders from. */
function fakeController(initial: CrewChannel[]) {
  let channels = initial
  const listeners = new Set<() => void>()
  const controller = {
    channelList: () => channels,
    viewedChannel: () => null,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    unreadCount: () => 0,
    totalUnread: () => 0,
    markRead: vi.fn(),
    upsertChannel: vi.fn(),
    setChannels(next: CrewChannel[]) {
      channels = next
      listeners.forEach((listener) => listener())
    },
  }
  return controller as unknown as ChannelNavigationController & { setChannels(next: CrewChannel[]): void }
}

function apiStub(sections: () => ChannelSections, overrides: Partial<CrewApi> = {}) {
  const getChannelSections = vi.fn(async () => sections())
  const api = {
    listMembers: vi.fn().mockResolvedValue([]),
    listProfiles: vi.fn().mockResolvedValue([]),
    updateMember: vi.fn(),
    createChannel: vi.fn(),
    patchChannel: vi.fn(),
    getChannelSections,
    putChannelSections: vi.fn(async (body: ChannelSections) => body),
    ...overrides,
  }
  return { api: api as unknown as CrewApi, getChannelSections }
}

const EMPTY: ChannelSections = { sections: [], assignments: {} }

describe('CrewPane sections refresh', () => {
  it('re-reads sections when the channel set changes so programmatic groupings appear', async () => {
    let remote: ChannelSections = EMPTY
    const { api, getChannelSections } = apiStub(() => remote)
    const controller = fakeController([channel('hq')])
    render(<CrewPane api={api} controller={controller} />)
    await waitFor(() => expect(getChannelSections).toHaveBeenCalled())
    expect(screen.queryByText('CultDrops')).toBeNull()

    // A script creates a channel AND files it under a new section in one go.
    remote = { sections: [{ id: 'cultdrops', name: 'CultDrops' }], assignments: { build: 'cultdrops' } }
    act(() => controller.setChannels([channel('hq'), channel('build', 'cultdrops-build')]))

    await waitFor(() => expect(screen.getByText('CultDrops')).toBeTruthy())
    // The new channel is rendered under its section, not the root group.
    const group = screen.getByText('CultDrops').closest('[data-section="cultdrops"]')
    expect(group?.textContent).toContain('cultdrops-build')
  })

  it('re-reads sections when the window regains focus', async () => {
    let remote: ChannelSections = EMPTY
    const { api, getChannelSections } = apiStub(() => remote)
    render(<CrewPane api={api} controller={fakeController([channel('hq')])} />)
    await waitFor(() => expect(getChannelSections).toHaveBeenCalled())
    const before = getChannelSections.mock.calls.length

    remote = { sections: [{ id: 'ops', name: 'Ops' }], assignments: {} }
    act(() => { window.dispatchEvent(new Event('focus')) })

    await waitFor(() => expect(getChannelSections.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy())
  })

  it('polls sections on a timer', async () => {
    vi.useFakeTimers()
    try {
      let remote: ChannelSections = EMPTY
      const { api, getChannelSections } = apiStub(() => remote)
      render(<CrewPane api={api} controller={fakeController([channel('hq')])} />)
      await act(async () => { await Promise.resolve() })
      const before = getChannelSections.mock.calls.length
      remote = { sections: [{ id: 'later', name: 'Later' }], assignments: {} }
      await act(async () => { await vi.advanceTimersByTimeAsync(10_500) })
      expect(getChannelSections.mock.calls.length).toBeGreaterThan(before)
      expect(screen.getByText('Later')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a stale fetch overwrite a save that is in flight', async () => {
    let releaseFetch: (value: ChannelSections) => void = () => undefined
    let fetchCount = 0
    const getChannelSections = vi.fn(() => {
      fetchCount += 1
      if (fetchCount === 1) return Promise.resolve(EMPTY)
      // Second fetch (triggered by focus) hangs until the test releases it.
      return new Promise<ChannelSections>((resolve) => { releaseFetch = resolve })
    })
    let releaseSave: (value: ChannelSections) => void = () => undefined
    const putChannelSections = vi.fn((_body: ChannelSections) => new Promise<ChannelSections>((resolve) => { releaseSave = resolve }))
    const { api } = apiStub(() => EMPTY, {
      getChannelSections: getChannelSections as unknown as CrewApi['getChannelSections'],
      putChannelSections: putChannelSections as unknown as CrewApi['putChannelSections'],
    })
    const controller = fakeController([channel('hq')])
    const view = render(<CrewPane api={api} controller={controller} />)
    await waitFor(() => expect(getChannelSections).toHaveBeenCalledTimes(1))

    // Start a slow poll, then the user creates a section while it is pending.
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(getChannelSections).toHaveBeenCalledTimes(2))
    // Context menus render inline in the SDK mock, so the "New section…"
    // verb is reachable directly.
    fireEvent.click(screen.getAllByText('New section…')[0])
    const input = await screen.findByPlaceholderText(/Section name/)
    fireEvent.change(input, { target: { value: 'Fresh' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(putChannelSections).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Fresh')).toBeTruthy()

    // The stale poll resolves with the pre-save document: it must be ignored.
    act(() => releaseFetch(EMPTY))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Fresh')).toBeTruthy()

    // The save resolves: its result wins.
    const saved = putChannelSections.mock.calls[0][0]
    act(() => releaseSave(saved))
    await waitFor(() => expect(screen.getByText('Fresh')).toBeTruthy())
    view.unmount()
  })
})
