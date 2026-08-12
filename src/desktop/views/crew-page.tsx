import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { ChannelList } from '../components/channel-list'
import { MemberRoster } from '../components/member-roster'
import type { CrewChannel, CrewMessage, HermesProfile } from '../types'
import { ChannelView } from './channel-view'
import { ThreadView } from './thread-view'

export interface CrewPageProps {
  api: CrewApi
}

export function CrewPage({ api }: CrewPageProps) {
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [profiles, setProfiles] = useState<HermesProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [threadRoot, setThreadRoot] = useState<CrewMessage | null>(null)
  const [error, setError] = useState('')

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

  const selected = channels.find((channel) => channel.id === selectedId) || null

  async function createChannel(body: Record<string, unknown>) {
    const created = await api.createChannel(body)
    setChannels((current) => [...current, created])
    setSelectedId(created.id)
    setThreadRoot(null)
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-(--ui-stroke-secondary) px-5 py-4">
        <h1 className="text-base font-semibold">Hermes Crew</h1>
        <p className="mt-1 text-sm text-(--ui-text-secondary)">
          Persistent Hermes profiles working together in local channels.
        </p>
      </header>
      {error ? <p role="alert" className="p-4 text-sm text-red-500">{error}</p> : null}
      <section className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)_280px]">
        <div className="min-h-0 border-r border-(--ui-stroke-secondary)"><ChannelList channels={channels} onCreate={createChannel} onSelect={(id) => { setSelectedId(id); setThreadRoot(null) }} profiles={profiles} selectedId={selectedId} /></div>
        {selected ? <ChannelView api={api} channel={selected} onOpenThread={setThreadRoot} profiles={profiles} /> : <div className="grid place-items-center p-6 text-sm text-(--ui-text-tertiary)">Create a channel to assemble your crew.</div>}
        {selected && threadRoot ? <ThreadView api={api} channelId={selected.id} onClose={() => setThreadRoot(null)} profiles={profiles} root={threadRoot} /> : <div className="min-h-0 border-l border-(--ui-stroke-secondary)"><MemberRoster profiles={profiles} /></div>}
      </section>
    </main>
  )
}
