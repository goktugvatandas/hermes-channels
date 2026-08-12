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
  channelLabel,
  channelPath,
} from '../../src/desktop/channel-navigation'
import type { CrewChannel } from '../../src/desktop/types'

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
    expect(channelLabel('general', 0)).toBe('# general')
    expect([...live.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: ROUTES_AREA, data: { path: '/crew/channel/general-id' } }),
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        order: 56,
        data: {
          codicon: 'comment-discussion',
          label: '# general',
          path: '/crew/channel/general-id',
        },
      }),
      expect.objectContaining({
        area: SIDEBAR_NAV_AREA,
        order: 57,
        data: {
          codicon: 'comment-discussion',
          label: '# research',
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
        data: expect.objectContaining({ label: '# lobby' }),
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
