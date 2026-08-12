import { PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, host } from '@hermes/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

import plugin from '../../src/desktop/plugin'

describe('Hermes Crew plugin registration', () => {
  it('registers its route, sidebar row, and palette command', () => {
    const dispose = vi.fn()
    let contributions: Array<{
      id: string
      area: string
      data: Record<string, unknown> & { run?: () => void }
    }> = []
    const registerMany = vi.fn((items: typeof contributions) => {
      contributions = items
      return dispose
    })
    const onDispose = vi.fn()
    const navigate = vi.spyOn(host, 'navigate')
    const rest = vi.fn()
    const ctx = {
      rest,
      socket: vi.fn(),
      registerMany,
      onDispose,
    }

    plugin.register(ctx as never)

    expect(contributions).toHaveLength(3)
    expect(contributions[0]).toMatchObject({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/crew' },
    })
    expect(contributions[1]).toMatchObject({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { label: 'Crew', path: '/crew' },
    })
    expect(contributions[2]).toMatchObject({
      id: 'open',
      area: PALETTE_AREA,
      data: { id: 'hermes-crew.open', label: 'Open Hermes Crew' },
    })

    contributions[2].data.run?.()
    expect(navigate).toHaveBeenCalledWith('/crew')
    expect(plugin.id).toBe('hermes-crew')
    expect(plugin.defaultEnabled).toBe(false)
  })
})
