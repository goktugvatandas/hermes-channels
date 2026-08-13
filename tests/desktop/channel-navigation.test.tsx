import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type PluginContext,
  type PluginContribution,
  type PluginStorage,
} from '@hermes/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

import type { CrewApi } from '../../src/desktop/api'
import {
  ChannelNavigationController,
  NAVIGATION_STORAGE_KEY,
  type ChannelNavigationState,
  channelLabel,
  channelPath,
} from '../../src/desktop/channel-navigation'
import type { CrewChannel, EventFrame } from '../../src/desktop/types'

function memoryStorage(seed: Record<string, unknown> = {}): PluginStorage {
  const values = new Map(Object.entries(seed))
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) as never : fallback,
    set: (key, value) => { values.set(key, value) },
    remove: (key) => { values.delete(key) },
  }
}

const general: CrewChannel = {
  id: 'general-id',
  name: 'general',
  purpose: '',
  topic: '',
  defaultResponderProfile: null,
  defaultProject: null,
  allowedProjects: [],
  routingRules: {},
  createdAt: 1,
  updatedAt: 1,
}
const research: CrewChannel = {
  ...general,
  id: 'research-id',
  name: 'research',
  createdAt: 2,
  updatedAt: 2,
}

function registrationHarness() {
  const live = new Map<string, PluginContribution>()
  const register = vi.fn((item: PluginContribution) => {
    live.set(item.id, item)
    return () => { live.delete(item.id) }
  })
  return { live, register }
}

function controllerFixture(options: {
  channels: CrewChannel[]
  events?: (after: number) => Promise<EventFrame[]>
  pollIntervalMs?: number
  register?: (item: PluginContribution) => () => void
  socket?: (path: string, listener: (data: unknown) => void) => () => void
  state?: ChannelNavigationState
  storage?: PluginStorage
}) {
  const storage = options.storage ?? memoryStorage(
    options.state ? { [NAVIGATION_STORAGE_KEY]: options.state } : {},
  )
  return new ChannelNavigationController({
    api: {
      listChannels: vi.fn(async () => options.channels),
      events: vi.fn(options.events ?? (async () => [])),
    },
    register: options.register ?? registrationHarness().register,
    renderChannel: (id) => <div data-channel={id} />,
    socket: options.socket ?? vi.fn(() => vi.fn()),
    storage,
    pollIntervalMs: options.pollIntervalMs,
  })
}

describe('channel navigation SDK contract', () => {
  it('supports dynamic registration and plugin-scoped persistence', () => {
    const storage = memoryStorage()
    const unregister = vi.fn()
    const context = {
      register: vi.fn((_contribution: PluginContribution) => unregister),
      storage,
    } satisfies Pick<PluginContext, 'register' | 'storage'>

    context.storage.set('navigation', { unread: 2 })

    expect(context.storage.get('navigation', null)).toEqual({ unread: 2 })
    expect(context.register({ id: 'channel-a', area: 'sidebar.nav' })).toBe(unregister)
  })
})

describe('channel navigation reconciliation', () => {
  it('registers ordered native routes and sidebar rows for current channels', async () => {
    const { live, register } = registrationHarness()
    const controller = new ChannelNavigationController({
      api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
      register,
      storage: memoryStorage(),
      socket: vi.fn(() => vi.fn()),
      renderChannel: (id) => <div data-channel={id} />,
    })

    await controller.reconcile()

    expect(channelPath('general/id')).toBe('/crew/channel/general%2Fid')
    expect(channelLabel('general', 0)).toBe('general')
    expect([...live.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: ROUTES_AREA, data: { path: '/crew/channel/general-id' } }),
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        order: 56,
        data: {
          codicon: 'symbol-numeric',
          label: 'general',
          path: '/crew/channel/general-id',
        },
      }),
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        order: 57,
        data: {
          codicon: 'symbol-numeric',
          label: 'research',
          path: '/crew/channel/research-id',
        },
      }),
    ]))
  })

  it('updates renamed channels and disposes deleted channel contributions', async () => {
    const { live, register } = registrationHarness()
    const api = { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi
    const controller = new ChannelNavigationController({
      api,
      register,
      storage: memoryStorage(),
      socket: vi.fn(() => vi.fn()),
      renderChannel: (id) => <div data-channel={id} />,
    })
    await controller.reconcile()

    await controller.reconcile([{ ...general, name: 'lobby', updatedAt: 3 }])

    expect([...live.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        data: expect.objectContaining({ label: 'lobby' }),
      }),
    ]))
    expect([...live.values()].some((item) => item.id.includes('research-id'))).toBe(false)
  })

  it('disposes every dynamic contribution', async () => {
    const { live, register } = registrationHarness()
    const controller = new ChannelNavigationController({
      api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
      register,
      storage: memoryStorage(),
      socket: vi.fn(() => vi.fn()),
      renderChannel: (id) => <div data-channel={id} />,
    })
    await controller.reconcile()

    controller.dispose()

    expect(live.size).toBe(0)
  })

  it('keeps healthy channels live when one channel registration fails', async () => {
    const { live, register: baseRegister } = registrationHarness()
    const register = vi.fn((item: PluginContribution) => {
      if (item.id.includes('research-id')) throw new Error('broken contribution')
      return baseRegister(item)
    })
    const controller = new ChannelNavigationController({
      api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
      register,
      storage: memoryStorage(),
      socket: vi.fn(() => vi.fn()),
      renderChannel: (id) => <div data-channel={id} />,
    })

    await controller.reconcile()

    expect([...live.keys()]).toEqual(['channel-route-general-id', 'channel-nav-general-id'])
  })
})

describe('channel navigation unread state', () => {
  it('increments an inactive channel once for a completed agent result', async () => {
    const storage = memoryStorage({
      [NAVIGATION_STORAGE_KEY]: { version: 1, lastEventSequence: 4, unreadByChannel: {} },
    })
    const { live, register } = registrationHarness()
    const controller = controllerFixture({ storage, register, channels: [general] })
    await controller.reconcile()

    controller.processEvents([
      { sequence: 5, type: 'completed', channelId: general.id, turnId: 'turn-1', payload: { messageId: 'agent-message' } },
      { sequence: 5, type: 'completed', channelId: general.id, turnId: 'turn-1', payload: { messageId: 'agent-message' } },
    ])

    expect([...live.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        data: expect.objectContaining({ label: 'general (1)' }),
      }),
    ]))
    expect(storage.get(NAVIGATION_STORAGE_KEY, null)).toEqual({
      version: 1,
      lastEventSequence: 5,
      unreadByChannel: { [general.id]: 1 },
    })
  })

  it('counts thread replies by channel but ignores non-result events', async () => {
    const controller = controllerFixture({
      state: { version: 1, lastEventSequence: 10, unreadByChannel: {} },
      channels: [general],
    })
    await controller.reconcile()

    controller.processEvents([
      { sequence: 11, type: 'streaming', channelId: general.id, turnId: 'turn-2', payload: { text: 'work' } },
      { sequence: 12, type: 'routing_decision', channelId: general.id, turnId: null, payload: {} },
      { sequence: 13, type: 'completed', channelId: general.id, turnId: 'turn-2', payload: { messageId: 'thread-reply' } },
    ])

    expect(controller.unreadCount(general.id)).toBe(1)
  })

  it('does not count messages in the visible channel and clears persisted unread on view', async () => {
    const controller = controllerFixture({
      state: { version: 1, lastEventSequence: 20, unreadByChannel: { [general.id]: 3 } },
      channels: [general],
    })
    await controller.reconcile()

    controller.setViewedChannel(general.id)
    controller.processEvents([
      { sequence: 21, type: 'completed', channelId: general.id, turnId: 'turn-3', payload: { messageId: 'visible-result' } },
    ])

    expect(controller.unreadCount(general.id)).toBe(0)
  })

  it('normalizes corrupt persisted counts and ignores malformed events', async () => {
    const storage = memoryStorage({
      [NAVIGATION_STORAGE_KEY]: {
        version: 1,
        lastEventSequence: 7,
        unreadByChannel: { [general.id]: -2, unknown: 1.5 },
      },
    })
    const controller = controllerFixture({ channels: [general], storage })
    await controller.reconcile()

    controller.processEvents([
      { sequence: Number.NaN, type: 'completed', channelId: general.id, turnId: 'bad', payload: { messageId: 'bad' } },
      { sequence: 8, type: 'completed', channelId: general.id, turnId: 'empty', payload: { messageId: '' } },
    ])

    expect(controller.unreadCount(general.id)).toBe(0)
    expect(controller.lastEventSequence()).toBe(8)
  })

  it('removes unread state when its channel is deleted', async () => {
    const storage = memoryStorage({
      [NAVIGATION_STORAGE_KEY]: {
        version: 1,
        lastEventSequence: 9,
        unreadByChannel: { [general.id]: 2, [research.id]: 4 },
      },
    })
    const controller = controllerFixture({ channels: [general, research], storage })
    await controller.reconcile()

    await controller.reconcile([general])

    expect(storage.get(NAVIGATION_STORAGE_KEY, null)).toEqual({
      version: 1,
      lastEventSequence: 9,
      unreadByChannel: { [general.id]: 2 },
    })
  })

  it('restores unread counts and the cursor after controller recreation', async () => {
    const storage = memoryStorage({
      [NAVIGATION_STORAGE_KEY]: { version: 1, lastEventSequence: 2, unreadByChannel: {} },
    })
    const first = controllerFixture({ channels: [general], storage })
    await first.reconcile()
    first.processEvents([
      { sequence: 3, type: 'completed', channelId: general.id, turnId: 'turn', payload: { messageId: 'reply' } },
    ])

    const restored = controllerFixture({ channels: [general], storage })

    expect(restored.unreadCount(general.id)).toBe(1)
    expect(restored.lastEventSequence()).toBe(3)
  })
})

describe('channel navigation lifecycle', () => {
  it('seeds a new installation at the latest historical sequence without unread counts', async () => {
    const events = vi.fn(async () => [
      { sequence: 40, type: 'completed', channelId: general.id, turnId: 'old', payload: { messageId: 'old-result' } },
    ])
    const controller = controllerFixture({ channels: [general], events })

    const dispose = controller.start()
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(0))

    expect(controller.unreadCount(general.id)).toBe(0)
    expect(controller.lastEventSequence()).toBe(40)
    dispose()
  })

  it('deduplicates the same completion from socket and polling', async () => {
    vi.useFakeTimers()
    let socketMessage: (data: unknown) => void = () => undefined
    const frame: EventFrame = {
      sequence: 51,
      type: 'completed',
      channelId: general.id,
      turnId: 'new',
      payload: { messageId: 'new-result' },
    }
    const events = vi.fn(async (after: number) => after === 0 ? [] : [frame])
    const controller = controllerFixture({
      channels: [general],
      events,
      socket: (_path, listener) => { socketMessage = listener; return vi.fn() },
      state: { version: 1, lastEventSequence: 50, unreadByChannel: {} },
      pollIntervalMs: 20,
    })
    const dispose = controller.start()
    await vi.waitFor(() => expect(events).toHaveBeenCalled())

    socketMessage(frame)
    await vi.advanceTimersByTimeAsync(20)

    expect(controller.unreadCount(general.id)).toBe(1)
    dispose()
    vi.useRealTimers()
  })

  it('allows only one event poll in flight', async () => {
    vi.useFakeTimers()
    let resolveSlow!: (frames: EventFrame[]) => void
    const events = vi.fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise<EventFrame[]>((resolve) => { resolveSlow = resolve }))
      .mockResolvedValue([])
    const controller = controllerFixture({
      channels: [general],
      events,
      state: { version: 1, lastEventSequence: 1, unreadByChannel: {} },
      pollIntervalMs: 20,
    })
    const dispose = controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60)
    expect(events).toHaveBeenCalledTimes(2)
    resolveSlow([])
    await vi.advanceTimersByTimeAsync(20)
    expect(events).toHaveBeenCalledTimes(3)
    dispose()
    vi.useRealTimers()
  })

  it('retries failed channel discovery without overlapping reconciliations', async () => {
    vi.useFakeTimers()
    let resolveRetry!: (channels: CrewChannel[]) => void
    const listChannels = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<CrewChannel[]>((resolve) => { resolveRetry = resolve }))
      .mockResolvedValue([general])
    const controller = new ChannelNavigationController({
      api: { listChannels, events: vi.fn(async () => []) },
      register: registrationHarness().register,
      renderChannel: (id) => <div data-channel={id} />,
      socket: vi.fn(() => vi.fn()),
      storage: memoryStorage(),
      reconcileIntervalMs: 20,
    })
    const dispose = controller.start()
    await vi.waitFor(() => expect(listChannels).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(60)
    expect(listChannels).toHaveBeenCalledTimes(2)
    resolveRetry([general])
    await vi.advanceTimersByTimeAsync(20)
    expect(listChannels).toHaveBeenCalledTimes(3)
    dispose()
    vi.useRealTimers()
  })

  it('disposes sockets and timers and ignores late work', async () => {
    vi.useFakeTimers()
    const socketDispose = vi.fn()
    let resolveEvents!: (frames: EventFrame[]) => void
    const events = vi.fn(() => new Promise<EventFrame[]>((resolve) => { resolveEvents = resolve }))
    const controller = controllerFixture({
      channels: [general],
      events,
      socket: vi.fn(() => socketDispose),
      pollIntervalMs: 20,
      state: { version: 1, lastEventSequence: 1, unreadByChannel: {} },
    })
    const dispose = controller.start()
    await vi.waitFor(() => expect(events).toHaveBeenCalled())

    dispose()
    resolveEvents([
      { sequence: 2, type: 'completed', channelId: general.id, turnId: 'late', payload: { messageId: 'late' } },
    ])
    await vi.advanceTimersByTimeAsync(100)

    expect(socketDispose).toHaveBeenCalledOnce()
    expect(controller.unreadCount(general.id)).toBe(0)
    vi.useRealTimers()
  })
})
