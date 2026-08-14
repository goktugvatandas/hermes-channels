import {
  PALETTE_AREA,
  ROUTES_AREA,
  host,
  type PluginContribution,
  type PluginStorage,
} from '@hermes/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

import plugin from '../../src/desktop/plugin'
import type { CrewChannel } from '../../src/desktop/types'

const channel: CrewChannel = {
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

function memoryStorage(): PluginStorage {
  const values = new Map<string, unknown>()
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) as never : fallback,
    set: (key, value) => { values.set(key, value) },
    remove: (key) => { values.delete(key) },
  }
}

describe('Hermes Channels plugin registration', () => {
  it('starts dynamic channel navigation alongside the Channels pane', async () => {
    const contributions = new Map<string, PluginContribution>()
    const register = vi.fn((item: PluginContribution) => {
      contributions.set(item.id, item)
      return () => { contributions.delete(item.id) }
    })
    const cleanups: Array<() => void> = []
    const rest = vi.fn(async (path: string) => {
      if (path === '/channels') return [channel]
      if (path === '/events?after=0') return []
      throw new Error(`Unexpected REST path: ${path}`)
    })
    const ctx = {
      rest,
      socket: vi.fn(() => vi.fn()),
      register,
      registerMany: vi.fn((items: PluginContribution[]) => {
        const disposers = items.map(register)
        return () => disposers.forEach((dispose) => dispose())
      }),
      onDispose: vi.fn((cleanup: () => void) => { cleanups.push(cleanup) }),
      storage: memoryStorage(),
    }
    const navigate = vi.spyOn(host, 'navigate')

    plugin.register(ctx as never)
    await vi.waitFor(() => expect([...contributions.keys()]).toEqual(
      expect.arrayContaining(['channel-route-general-id']),
    ))

    expect([...contributions.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'page', area: ROUTES_AREA, data: { path: '/channels' } }),
      expect.objectContaining({ id: 'pane', area: 'panes', title: 'Channels' }),
      expect.objectContaining({ id: 'open', area: PALETTE_AREA }),
    ]))
    const palette = contributions.get('open')?.data as { run?: () => void }
    palette.run?.()
    expect(navigate).toHaveBeenCalledWith('/channels')
    expect(plugin.id).toBe('hermes-channels')
    expect(plugin.defaultEnabled).toBe(false)

    cleanups.forEach((cleanup) => cleanup())
    expect([...contributions.values()].some((item) => item.id.includes('channel-route'))).toBe(false)
  })
})
