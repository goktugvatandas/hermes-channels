import { useEffect, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import { ChannelList } from '../components/channel-list'
import { ActivityPanel } from '../components/activity-panel'
import { FirstRun } from '../components/first-run'
import { SearchView } from '../components/search-view'
import { MemberRoster } from '../components/member-roster'
import type { CrewChannel, CrewMessage, EventFrame, HermesProfile } from '../types'
import { ChannelView } from './channel-view'
import { ThreadView } from './thread-view'
import { StudioView } from './studio-view'

export interface CrewPageProps {
  api: CrewApi
}

export function CrewPage({ api }: CrewPageProps) {
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [profiles, setProfiles] = useState<HermesProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [threadRoot, setThreadRoot] = useState<CrewMessage | null>(null)
  const [events, setEvents] = useState<EventFrame[]>([])
  const eventCursor = useRef(0)
  const [error, setError] = useState('')
  const [view, setView] = useState<'channels' | 'search' | 'studio'>('channels')

  useEffect(() => {
    let current = true
    void Promise.all([api.listChannels(), api.listProfiles()])
      .then(([nextChannels, nextProfiles]) => {
        if (!current) return
        setChannels(nextChannels)
        setProfiles(nextProfiles)
        setSelectedId((selected) => selected || nextChannels[0]?.id || null)
      })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : 'Crew could not be loaded') })
    return () => { current = false }
  }, [api])

  useEffect(() => {
    let current = true
    async function poll() {
      try {
        const next = await api.events(eventCursor.current)
        if (!current || !next.length) return
        eventCursor.current = Math.max(eventCursor.current, ...next.map((event) => event.sequence))
        setEvents((existing) => [...existing, ...next].slice(-500))
      } catch {
        // Activity polling is a fallback path; the next interval retries.
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 2_000)
    return () => { current = false; clearInterval(interval) }
  }, [api])

  const selected = channels.find((channel) => channel.id === selectedId) || null
  const messageRevision = events.reduce((latest, event) => (
    event.channelId === selectedId && event.type === 'completed'
      ? Math.max(latest, event.sequence)
      : latest
  ), 0)

  async function createChannel(body: Record<string, unknown>) {
    const created = await api.createChannel(body)
    setChannels((current) => [...current, created])
    setSelectedId(created.id)
    setThreadRoot(null)
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-start justify-between border-b border-(--ui-stroke-secondary) px-5 py-4">
        <div><h1 className="text-base font-semibold">Hermes Crew</h1>
        <p className="mt-1 text-sm text-(--ui-text-secondary)">
          Persistent Hermes profiles working together in local channels.
        </p></div><div className="flex gap-2 text-sm"><button aria-pressed={view === 'channels'} onClick={() => setView('channels')} type="button">Channels</button><button aria-pressed={view === 'search'} onClick={() => setView('search')} type="button">Search</button><button aria-pressed={view === 'studio'} onClick={() => setView('studio')} type="button">Studio</button></div>
      </header>
      {error ? <p role="alert" className="p-4 text-sm text-red-500">{error}</p> : null}
      {view === 'studio' ? <StudioView api={api} /> : view === 'search' ? <SearchView api={api} channels={channels} profiles={profiles} /> :
      <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)_280px]">
        <div className="min-h-0 border-r border-(--ui-stroke-secondary)"><ChannelList channels={channels} onCreate={createChannel} onSelect={(id) => { setSelectedId(id); setThreadRoot(null) }} profiles={profiles} selectedId={selectedId} /></div>
        {selected ? <ChannelView api={api} channel={selected} messageRevision={messageRevision} onOpenThread={setThreadRoot} profiles={profiles} /> : profiles.length ? <FirstRun api={api} onComplete={(channel) => { setChannels([channel]); setSelectedId(channel.id) }} profiles={profiles} /> : <div className="grid place-items-center p-6 text-sm text-(--ui-text-tertiary)">Create a Hermes profile first.</div>}
        {selected && threadRoot ? <ThreadView api={api} channelId={selected.id} onClose={() => setThreadRoot(null)} profiles={profiles} root={threadRoot} /> : <aside className="min-h-0 overflow-auto border-l border-(--ui-stroke-secondary)"><MemberRoster profiles={profiles} /><ActivityPanel api={api} events={events.filter((event) => !selected || event.channelId === selected.id)} /></aside>}
      </section>}
    </main>
  )
}
