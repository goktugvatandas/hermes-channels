import type { PluginContext, PluginContribution, PluginStorage } from '@hermes/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

function memoryStorage(seed: Record<string, unknown> = {}): PluginStorage {
  const values = new Map(Object.entries(seed))
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) as never : fallback,
    set: (key, value) => { values.set(key, value) },
    remove: (key) => { values.delete(key) },
  }
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
