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
import type { CrewChannel, EventFrame } from './types'

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
  private readonly hadPersistedState: boolean
  private state: ChannelNavigationState
  private viewedChannelId: string | null = null
  private started = false
  private bootstrapped = false
  private eventPollInFlight = false
  private reconcileInFlight = false
  private pendingFrames: EventFrame[] = []
  private socketDispose: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: ChannelNavigationOptions) {
    const persisted = options.storage.get<unknown>(NAVIGATION_STORAGE_KEY, null)
    this.hadPersistedState = this.isPersistedState(persisted)
    this.state = this.normalizeState(persisted)
  }

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

    let stateChanged = false
    for (const id of Object.keys(this.state.unreadByChannel)) {
      if (nextIds.has(id)) continue
      delete this.state.unreadByChannel[id]
      stateChanged = true
    }
    if (stateChanged) this.persist()

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

  start(): () => void {
    if (this.started) return () => this.dispose()
    this.started = true
    this.socketDispose = this.options.socket('/events', (data) => {
      if (this.disposed) return
      const frame = this.asEventFrame(data)
      if (!frame) return
      if (!this.bootstrapped) this.pendingFrames.push(frame)
      else this.processEvents([frame])
    })
    void this.bootstrap()
    this.pollTimer = setInterval(
      () => { void this.pollEvents() },
      this.options.pollIntervalMs ?? 2_000,
    )
    this.reconcileTimer = setInterval(
      () => { void this.reconcileOnce() },
      this.options.reconcileIntervalMs ?? 10_000,
    )
    return () => this.dispose()
  }

  lastEventSequence(): number {
    return this.state.lastEventSequence
  }

  unreadCount(channelId: string): number {
    return this.state.unreadByChannel[channelId] ?? 0
  }

  setViewedChannel(channelId: string | null): void {
    this.viewedChannelId = channelId
    if (!channelId || this.unreadCount(channelId) === 0) return
    delete this.state.unreadByChannel[channelId]
    this.persist()
    this.refreshSidebar(channelId)
  }

  processEvents(frames: EventFrame[]): void {
    for (const frame of [...frames].sort((a, b) => a.sequence - b.sequence)) {
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.state.lastEventSequence) {
        continue
      }
      this.state.lastEventSequence = frame.sequence
      const messageId = frame.payload?.messageId
      if (
        frame.type === 'completed' &&
        typeof messageId === 'string' && messageId.length > 0 &&
        frame.channelId !== this.viewedChannelId &&
        this.registrations.has(frame.channelId)
      ) {
        this.state.unreadByChannel[frame.channelId] = this.unreadCount(frame.channelId) + 1
        this.refreshSidebar(frame.channelId)
      }
    }
    this.persist()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
    this.pollTimer = null
    this.reconcileTimer = null
    this.socketDispose?.()
    this.socketDispose = null
    this.pendingFrames = []
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
      sidebarDispose = this.registerSidebar(channel, order)
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

  private refreshSidebar(channelId: string): void {
    const existing = this.registrations.get(channelId)
    if (!existing || this.disposed) return
    existing.sidebarDispose()
    try {
      existing.sidebarDispose = this.registerSidebar(existing.channel, existing.order)
    } catch {
      // A future reconciliation retries the contribution.
    }
  }

  private registerSidebar(channel: CrewChannel, order: number): () => void {
    return this.options.register({
      id: `channel-nav-${channel.id}`,
      area: SIDEBAR_NAV_AREA,
      order,
      data: {
        codicon: 'comment-discussion',
        label: channelLabel(channel.name, this.unreadCount(channel.id)),
        path: channelPath(channel.id),
      } satisfies SidebarNavContribution,
    })
  }

  private persist(): void {
    this.options.storage.set(NAVIGATION_STORAGE_KEY, this.state)
  }

  private async bootstrap(): Promise<void> {
    await this.reconcileOnce()
    if (this.disposed || this.bootstrapped || this.eventPollInFlight) return

    this.eventPollInFlight = true
    try {
      const frames = await this.options.api.events(
        this.hadPersistedState ? this.state.lastEventSequence : 0,
      )
      if (this.disposed) return

      if (this.hadPersistedState) {
        this.processEvents(frames)
      } else {
        for (const frame of frames) {
          if (Number.isSafeInteger(frame.sequence)) {
            this.state.lastEventSequence = Math.max(
              this.state.lastEventSequence,
              frame.sequence,
            )
          }
        }
        this.persist()
      }
      this.bootstrapped = true
      const pending = this.pendingFrames
      this.pendingFrames = []
      this.processEvents(pending)
    } catch {
      // Periodic polling retries event bootstrap.
    } finally {
      this.eventPollInFlight = false
    }
  }

  private async pollEvents(): Promise<void> {
    if (this.disposed) return
    if (!this.bootstrapped) {
      await this.bootstrap()
      return
    }
    if (this.eventPollInFlight) return

    this.eventPollInFlight = true
    try {
      const frames = await this.options.api.events(this.state.lastEventSequence)
      if (!this.disposed) this.processEvents(frames)
    } catch {
      // The next interval retries from the persisted cursor.
    } finally {
      this.eventPollInFlight = false
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (this.disposed || this.reconcileInFlight) return
    this.reconcileInFlight = true
    try {
      await this.reconcile()
    } catch {
      // Channel discovery is retried by the reconciliation interval.
    } finally {
      this.reconcileInFlight = false
    }
  }

  private asEventFrame(value: unknown): EventFrame | null {
    if (!value || typeof value !== 'object') return null
    const frame = value as Partial<EventFrame>
    if (
      typeof frame.type !== 'string' ||
      typeof frame.channelId !== 'string' ||
      (typeof frame.turnId !== 'string' && frame.turnId !== null) ||
      !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)
    ) {
      return null
    }
    return frame as EventFrame
  }

  private isPersistedState(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<ChannelNavigationState>
    return candidate.version === 1 &&
      Number.isSafeInteger(candidate.lastEventSequence) &&
      Number(candidate.lastEventSequence) >= 0 &&
      Boolean(candidate.unreadByChannel) &&
      typeof candidate.unreadByChannel === 'object' &&
      !Array.isArray(candidate.unreadByChannel)
  }

  private normalizeState(value: unknown): ChannelNavigationState {
    if (!this.isPersistedState(value)) {
      return { version: 1, lastEventSequence: 0, unreadByChannel: {} }
    }
    const candidate = value as ChannelNavigationState
    const unreadByChannel: Record<string, number> = {}
    for (const [channelId, count] of Object.entries(candidate.unreadByChannel)) {
      if (Number.isSafeInteger(count) && count > 0) unreadByChannel[channelId] = count
    }
    return {
      version: 1,
      lastEventSequence: candidate.lastEventSequence,
      unreadByChannel,
    }
  }
}
