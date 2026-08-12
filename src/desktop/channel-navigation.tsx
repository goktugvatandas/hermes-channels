import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type PluginContribution,
  type PluginStorage,
  type RouteContribution,
  type SidebarNavContribution,
} from '@hermes/plugin-sdk'
import type { ReactNode } from 'react'

import type { CrewApi } from './api'
import type { CrewChannel } from './types'

export const NAVIGATION_STORAGE_KEY = 'channel-navigation-v1'
const CHANNEL_ORDER_START = 56

export interface ChannelNavigationState {
  version: 1
  lastEventSequence: number
  unreadByChannel: Record<string, number>
}

interface ChannelNavigationOptions {
  api: Pick<CrewApi, 'events' | 'listChannels'>
  register(contribution: PluginContribution): () => void
  renderChannel(channelId: string): ReactNode
  socket(path: string, onMessage: (data: unknown) => void): () => void
  storage: PluginStorage
  pollIntervalMs?: number
  reconcileIntervalMs?: number
}

interface ChannelRegistration {
  channel: CrewChannel
  order: number
  routeDispose: () => void
  sidebarDispose: () => void
}

export function channelPath(channelId: string): string {
  return `/crew/channel/${encodeURIComponent(channelId)}`
}

export function channelLabel(name: string, unread: number): string {
  return unread > 0 ? `# ${name} (${unread})` : `# ${name}`
}

export class ChannelNavigationController {
  private readonly registrations = new Map<string, ChannelRegistration>()
  private channels: CrewChannel[] = []
  private disposed = false

  constructor(private readonly options: ChannelNavigationOptions) {}

  async reconcile(channels?: CrewChannel[]): Promise<void> {
    if (this.disposed) return

    const nextChannels = channels ?? await this.options.api.listChannels()

    const nextIds = new Set(nextChannels.map((channel) => channel.id))
    for (const [id, registration] of this.registrations) {
      if (nextIds.has(id)) continue
      registration.routeDispose()
      registration.sidebarDispose()
      this.registrations.delete(id)
    }

    this.channels = [...nextChannels]
    for (const [index, channel] of nextChannels.entries()) {
      try {
        this.registerChannel(channel, index)
      } catch {
        // Periodic reconciliation retries this channel without disturbing the rest.
      }
    }
  }

  upsertChannel(channel: CrewChannel): void {
    const next = [...this.channels.filter((item) => item.id !== channel.id), channel]
    void this.reconcile(next)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const registration of this.registrations.values()) {
      registration.routeDispose()
      registration.sidebarDispose()
    }
    this.registrations.clear()
  }

  private registerChannel(channel: CrewChannel, index: number): void {
    const existing = this.registrations.get(channel.id)
    const order = CHANNEL_ORDER_START + index
    if (existing && existing.channel.name === channel.name && existing.order === order) {
      return
    }

    const routeDispose = existing?.routeDispose ?? this.options.register({
      id: `channel-route-${channel.id}`,
      area: ROUTES_AREA,
      data: { path: channelPath(channel.id) } satisfies RouteContribution,
      render: () => this.options.renderChannel(channel.id),
    })

    existing?.sidebarDispose()
    let sidebarDispose: () => void
    try {
      sidebarDispose = this.options.register({
        id: `channel-nav-${channel.id}`,
        area: SIDEBAR_NAV_AREA,
        order,
        data: {
          codicon: 'comment-discussion',
          label: channelLabel(channel.name, 0),
          path: channelPath(channel.id),
        } satisfies SidebarNavContribution,
      })
    } catch (error) {
      if (!existing) routeDispose()
      throw error
    }

    this.registrations.set(channel.id, {
      channel,
      order,
      routeDispose,
      sidebarDispose,
    })
  }
}
