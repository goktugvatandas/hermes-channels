import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import { channelUiSnapshot, updateChannelUiState, type ChannelUiState } from '../channel-ui-state'
import { summarizeTurns } from '../conversation-model'
import { ChannelList } from '../components/channel-list'
import { CrashGuard } from '../components/crash-guard'
import { ActivityPanel } from '../components/activity-panel'
import { IconButton } from '../components/icon-button'
import { FirstRun } from '../components/first-run'
import { SearchView } from '../components/search-view'
import { MemberRoster } from '../components/member-roster'
import { DEFAULT_IDENTITY, PresentationContext } from '../presentation'
import type { CrewChannel, CrewMember, CrewMessage, EventFrame, HermesProfile, UserIdentity } from '../types'
import { ChannelView } from './channel-view'
import { HomeView } from './home-view'
import { ProfileView } from './profile-view'
import { SessionConsole } from './session-console'
import { ThreadView } from './thread-view'
import { SettingsView } from './settings-view'
import { StudioView } from './studio-view'

export type CrewView = 'home' | 'channels' | 'search' | 'workshop' | 'profile' | 'settings'

// Bounds the in-memory journal. Eviction is per-channel (newest N each), so
// one busy channel cannot push a quiet channel's backfilled history out of
// the buffer — a plain global slice would evict exactly what the channel
// backfill just added.
const EVENTS_PER_CHANNEL_LIMIT = 800

function mergeEvents(existing: EventFrame[], incoming: EventFrame[]): EventFrame[] {
  const known = new Set(existing.map((event) => event.sequence))
  const fresh = incoming.filter((event) => !known.has(event.sequence))
  if (!fresh.length) return existing
  const merged = [...existing, ...fresh].sort((left, right) => left.sequence - right.sequence)
  const perChannel = new Map<string, number>()
  const kept: EventFrame[] = []
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const event = merged[index]
    const count = perChannel.get(event.channelId) || 0
    if (count >= EVENTS_PER_CHANNEL_LIMIT) continue
    perChannel.set(event.channelId, count + 1)
    kept.push(event)
  }
  return kept.reverse()
}

export interface CrewPageProps {
  api: CrewApi
  initialChannelId?: string
  initialView?: CrewView
  onChannelCreated?(channel: CrewChannel): void
  onChannelViewed?(channelId: string | null): void
  onNavigateChannel?(channelId: string | null): void
  /** Desktop: root views are real routes; this navigates instead of switching in-page. */
  onNavigateView?(view: 'home' | 'workshop' | 'profile' | 'settings' | 'search'): void
}

// Module-level on purpose: defining this inside CrewPage would make it a new
// component type on every render, so React would remount the rail (and eat
// in-flight clicks) each time the 2s event poll updates state.
function DetailsRail({ api, events, channel, profiles, onClose, onOpenConsole, onMembershipChange, onChannelChange }: {
  api: CrewApi
  events: EventFrame[]
  channel: CrewChannel
  profiles: HermesProfile[]
  onClose(): void
  onOpenConsole(sessionId: string, profileId: string): void
  onMembershipChange?(): void
  onChannelChange?(channel: CrewChannel): void
}) {
  const channelId = channel.id
  return (
    <aside aria-label="Channel details" aria-modal="true" className="absolute inset-y-0 right-0 z-10 flex min-h-0 w-[300px] flex-col border-l border-(--ui-stroke-secondary) bg-background transition-[opacity,transform] duration-150 motion-reduce:transform-none motion-reduce:transition-none @4xl:static @4xl:w-[320px]" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <header className="flex min-h-14 items-center justify-between border-b border-(--ui-stroke-secondary) py-2 pl-4 pr-2">
        <h2 className="text-sm font-semibold">Details</h2>
        <IconButton codicon="close" label="Close details" onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <MemberRoster
          activeProfileIds={summarizeTurns(events.filter((event) => event.channelId === channelId))
            .filter((turn) => !turn.terminal)
            .map((turn) => turn.profileId)}
          api={api}
          channel={channel}
          onChannelChange={onChannelChange}
          onMembershipChange={onMembershipChange}
          profiles={profiles}
        />
        <ActivityPanel api={api} events={events.filter((event) => event.channelId === channelId)} onOpenConsole={onOpenConsole} />
      </div>
    </aside>
  )
}

export function CrewPage({
  api,
  initialChannelId,
  initialView = 'home',
  onChannelCreated,
  onChannelViewed,
  onNavigateChannel,
  onNavigateView,
}: CrewPageProps) {
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [profiles, setProfiles] = useState<HermesProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [threadRoot, setThreadRoot] = useState<CrewMessage | null>(null)
  const [events, setEvents] = useState<EventFrame[]>([])
  const eventCursor = useRef(0)
  const [error, setError] = useState('')
  // Standalone channel routes are always a channel surface regardless of initialView.
  const [view, setView] = useState<CrewView>(initialChannelId !== undefined ? 'channels' : initialView)

  // Hermes may reuse the mounted page component when switching between the
  // /crew, /channels/bot-management, and channel routes; follow the new route's intent.
  useEffect(() => {
    setView(initialChannelId !== undefined ? 'channels' : initialView)
    setSessionFocus(null)
  }, [initialChannelId, initialView])
  const [channelUi, setChannelUi] = useState<ChannelUiState>({})
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [membershipRevision, setMembershipRevision] = useState(0)
  const [members, setMembers] = useState<Record<string, CrewMember>>({})
  const [me, setMe] = useState<UserIdentity>(DEFAULT_IDENTITY)
  const presentation = useMemo(() => ({ members, me }), [members, me])

  // Stored avatars/display names for every member plus the human user.
  // Refreshed on view changes so Bot Management edits show up when returning to
  // channels without a poll.
  const presentationRequest = useRef(0)
  const refreshPresentation = useCallback(() => {
    // Sequenced so an older in-flight response can't overwrite a newer one.
    const token = ++presentationRequest.current
    void api.listMembers()
      .then((list) => {
        if (token !== presentationRequest.current) return
        setMembers(Object.fromEntries(list.map((member) => [member.profileId, member])))
      })
      .catch(() => undefined)
    void api.getMe()
      .then((identity) => { if (token === presentationRequest.current) setMe(identity) })
      .catch(() => undefined)
  }, [api])
  useEffect(() => { refreshPresentation() }, [refreshPresentation, view])
  const [sessionFocus, setSessionFocus] = useState<{ sessionId: string; profileId: string } | null>(null)
  const threadReturnFocus = useRef<HTMLElement | null>(null)

  // "Open session" navigates to the native Hermes session view in both
  // hosts; this opens the embedded Crew console instead (the menu option for
  // working without leaving the workspace).
  function openConsole(sessionId: string, profileId: string) {
    setSessionFocus({ sessionId, profileId })
  }

  useEffect(() => {
    let current = true
    void Promise.all([api.listChannels(), api.listProfiles()])
      .then(([nextChannels, nextProfiles]) => {
        if (!current) return
        setChannels(nextChannels)
        setProfiles(nextProfiles)
        setSelectedId((selected) => {
          if (initialChannelId && nextChannels.some((channel) => channel.id === initialChannelId)) {
            return initialChannelId
          }
          if (initialChannelId) onNavigateChannel?.(null)
          if (selected && nextChannels.some((channel) => channel.id === selected)) return selected
          return nextChannels[0]?.id || null
        })
      })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : 'Channels could not be loaded') })
    return () => { current = false }
  }, [api, initialChannelId, onNavigateChannel])

  useEffect(() => {
    const visible = view === 'channels' ? selectedId : null
    onChannelViewed?.(visible)
    return () => { onChannelViewed?.(null) }
  }, [onChannelViewed, selectedId, view])

  useEffect(() => {
    let current = true
    async function poll() {
      try {
        const next = await api.events(eventCursor.current)
        if (!current || !next.length) return
        eventCursor.current = Math.max(eventCursor.current, ...next.map((event) => event.sequence))
        setEvents((existing) => mergeEvents(existing, next))
      } catch {
        // Activity polling is a fallback path; the next interval retries.
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 2_000)
    return () => { current = false; clearInterval(interval) }
  }, [api])

  // A global recency cap starves quiet channels: without this backfill, one
  // busy channel could push another's whole history out of the buffer and
  // its details rail and message menus would go blank.
  useEffect(() => {
    if (!selectedId) return
    let current = true
    void api.events(0, selectedId, EVENTS_PER_CHANNEL_LIMIT)
      .then((history) => { if (current) setEvents((existing) => mergeEvents(existing, history)) })
      .catch(() => undefined)
    return () => { current = false }
  }, [api, selectedId])

  const selected = channels.find((channel) => channel.id === selectedId) || null
  const messageRevision = events.reduce((latest, event) => (
    event.channelId === selectedId && event.type === 'completed'
      ? Math.max(latest, event.sequence)
      : latest
  ), 0)

  async function createChannel(body: Record<string, unknown>) {
    const created = await api.createChannel(body)
    setChannels((current) => [...current, created])
    onChannelCreated?.(created)
    selectChannel(created.id)
  }

  // Browsing inside the Crew page stays inside the Crew page; the host's
  // sidebar channel links remain the way into standalone channel surfaces.
  function selectChannel(channelId: string) {
    if (onNavigateView) {
      // Channels are standalone routed pages on this host.
      onNavigateChannel?.(channelId)
      return
    }
    setSelectedId(channelId)
    setThreadRoot(null)
    setDetailsOpen(false)
    setSessionFocus(null)
    setView('channels')
  }

  function openThread(message: CrewMessage) {
    threadReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDetailsOpen(false)
    setThreadRoot(message)
  }

  function openDetails() {
    setThreadRoot(null)
    setDetailsOpen(true)
  }

  function openRootView(nextView: 'home' | 'search' | 'workshop' | 'profile' | 'settings') {
    if (onNavigateView) {
      onNavigateView(nextView)
      return
    }
    setSessionFocus(null)
    setView(nextView)
    onNavigateChannel?.(null)
  }

  if (initialChannelId !== undefined) {
    return (
      <PresentationContext.Provider value={presentation}>
      <main className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
        {error ? <p role="alert" className="p-4 text-sm text-red-500">{error}</p> : null}
        {sessionFocus ? <CrashGuard label="The session console" onClose={() => setSessionFocus(null)}><SessionConsole api={api} onClose={() => setSessionFocus(null)} profileName={sessionFocus.profileId} sessionId={sessionFocus.sessionId} /></CrashGuard> :
        <section className={`relative grid min-h-0 flex-1 grid-cols-1 ${threadRoot || detailsOpen ? '@4xl:grid-cols-[minmax(0,1fr)_auto]' : ''}`}>
          {selected ? <ChannelView api={api} channel={selected} events={events.filter((event) => event.channelId === selected.id)} membershipRevision={membershipRevision} messageRevision={messageRevision} onNavigate={(next) => { if (next === 'channels') return; openRootView(next) }} onOpenDetails={openDetails} onOpenThread={openThread} onUiSnapshot={(patch) => setChannelUi((current) => updateChannelUiState(current, selected.id, patch))} profiles={profiles} uiSnapshot={channelUiSnapshot(channelUi, selected.id)} /> : null}
          {selected && threadRoot ? <ThreadView api={api} channelId={selected.id} events={events.filter((event) => event.channelId === selected.id)} key={threadRoot.id} membershipRevision={membershipRevision} onClose={() => setThreadRoot(null)} profiles={profiles} returnFocusRef={threadReturnFocus} root={threadRoot} /> : selected && detailsOpen ? <DetailsRail api={api} channel={selected} events={events} onChannelChange={(updated) => setChannels((current) => current.map((item) => item.id === updated.id ? updated : item))} onClose={() => setDetailsOpen(false)} onMembershipChange={() => setMembershipRevision((value) => value + 1)} onOpenConsole={openConsole} profiles={profiles} /> : null}
        </section>}
      </main>
      </PresentationContext.Provider>
    )
  }

  return (
    <PresentationContext.Provider value={presentation}>
    <main className="@container flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-(--ui-stroke-secondary) px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Hermes Channels</h1>
          <p className="mt-0.5 hidden truncate text-sm text-(--ui-text-secondary) @2xl:block">
            Persistent Hermes profiles working together in local channels.
          </p>
        </div>
        <nav aria-label="Crew views" className="flex shrink-0 gap-1 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary) p-0.5 text-sm">
          {([
            ['home', 'Home', () => openRootView('home')],
            ['workshop', 'Bot Management', () => openRootView('workshop')],
            ['profile', 'Profile', () => openRootView('profile')],
            ['settings', 'Settings', () => openRootView('settings')],
          ] as const).map(([id, label, activate]) => (
            <button
              aria-pressed={view === id}
              className={`rounded-md px-3 py-1 transition-colors ${view === id ? 'bg-background font-medium shadow-sm' : 'text-(--ui-text-secondary) hover:text-foreground'}`}
              key={id}
              onClick={activate}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {error ? <p role="alert" className="p-4 text-sm text-red-500">{error}</p> : null}
      {sessionFocus ? <CrashGuard label="The session console" onClose={() => setSessionFocus(null)}><SessionConsole api={api} onClose={() => setSessionFocus(null)} profileName={sessionFocus.profileId} sessionId={sessionFocus.sessionId} /></CrashGuard> : view === 'home' ? (
        channels.length ? (
          <HomeView api={api} channels={channels} events={events} onOpenChannel={selectChannel} onOpenProfile={() => openRootView('profile')} onOpenWorkshop={() => openRootView('workshop')} profiles={profiles} />
        ) : profiles.length ? (
          <FirstRun api={api} onComplete={(channel) => { setChannels([channel]); onChannelCreated?.(channel); selectChannel(channel.id) }} profiles={profiles} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-sm text-(--ui-text-tertiary)">Create a Hermes profile first.</div>
        )

      ) : view === 'workshop' ? <StudioView api={api} onPresentationChange={refreshPresentation} /> : view === 'profile' ? <ProfileView api={api} identity={me} onIdentityChange={setMe} /> : view === 'settings' ? <SettingsView api={api} /> : view === 'search' ? <SearchView api={api} channels={channels} profiles={profiles} /> :
      <section className={`relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @2xl:grid-rows-1 ${threadRoot || detailsOpen ? '@2xl:grid-cols-[240px_minmax(0,1fr)] @4xl:grid-cols-[240px_minmax(0,1fr)_auto]' : '@2xl:grid-cols-[240px_minmax(0,1fr)]'}`}>
        <div className="min-h-0 max-h-44 border-b border-(--ui-stroke-secondary) @2xl:max-h-none @2xl:border-b-0 @2xl:border-r"><ChannelList channels={channels} onCreate={createChannel} onSelect={selectChannel} profiles={profiles} selectedId={selectedId} /></div>
        {selected ? <ChannelView api={api} channel={selected} events={events.filter((event) => event.channelId === selected.id)} membershipRevision={membershipRevision} messageRevision={messageRevision} onOpenDetails={openDetails} onOpenThread={openThread} onUiSnapshot={(patch) => setChannelUi((current) => updateChannelUiState(current, selected.id, patch))} profiles={profiles} uiSnapshot={channelUiSnapshot(channelUi, selected.id)} onNavigate={(next) => { if (next === 'channels') return; openRootView(next) }} /> : profiles.length ? <FirstRun api={api} onComplete={(channel) => { setChannels([channel]); onChannelCreated?.(channel); selectChannel(channel.id) }} profiles={profiles} /> : <div className="grid place-items-center p-6 text-sm text-(--ui-text-tertiary)">Create a Hermes profile first.</div>}
        {selected && threadRoot ? <ThreadView api={api} channelId={selected.id} events={events.filter((event) => event.channelId === selected.id)} key={threadRoot.id} membershipRevision={membershipRevision} onClose={() => setThreadRoot(null)} profiles={profiles} returnFocusRef={threadReturnFocus} root={threadRoot} /> : selected && detailsOpen ? <DetailsRail api={api} channel={selected} events={events} onChannelChange={(updated) => setChannels((current) => current.map((item) => item.id === updated.id ? updated : item))} onClose={() => setDetailsOpen(false)} onMembershipChange={() => setMembershipRevision((value) => value + 1)} onOpenConsole={openConsole} profiles={profiles} /> : null}
      </section>}
    </main>
    </PresentationContext.Provider>
  )
}
