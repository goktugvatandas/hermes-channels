import { useState, type FormEvent } from 'react'

import type { CrewChannel, HermesProfile } from '../types'

interface ChannelListProps {
  channels: CrewChannel[]
  profiles: HermesProfile[]
  selectedId: string | null
  onSelect(id: string): void
  onCreate(body: Record<string, unknown>): Promise<void>
}

export function ChannelList({
  channels,
  profiles,
  selectedId,
  onSelect,
  onCreate,
}: ChannelListProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [defaultResponder, setDefaultResponder] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await onCreate({
        name: name.trim(),
        defaultResponderProfile: defaultResponder || null,
        members: profiles.map((profile) => ({
          profileId: profile.name,
          activationPolicy:
            profile.name === defaultResponder ? 'always' : 'mentioned',
        })),
      })
      setName('')
      setDefaultResponder('')
      setCreating(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <nav aria-label="Crew channels" className="flex min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
          Channels
        </h2>
        <button className="rounded px-2 py-1 text-xs hover:bg-(--ui-surface-secondary)" onClick={() => setCreating(!creating)} type="button">
          New channel
        </button>
      </div>
      {creating ? (
        <form className="grid gap-2 rounded border border-(--ui-stroke-secondary) p-2" onSubmit={submit}>
          <label className="grid gap-1 text-xs">
            Channel name
            <input className="rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1.5" onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label className="grid gap-1 text-xs">
            Default responder
            <select className="rounded border border-(--ui-stroke-secondary) bg-background px-2 py-1.5" onChange={(event) => setDefaultResponder(event.target.value)} value={defaultResponder}>
              <option value="">None</option>
              {profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
            </select>
          </label>
          <button className="rounded bg-(--ui-accent) px-2 py-1.5 text-xs text-white disabled:opacity-50" disabled={saving || !name.trim()} type="submit">
            Create channel
          </button>
        </form>
      ) : null}
      <div className="grid gap-1 overflow-auto">
        {channels.map((channel) => (
          <button
            aria-current={selectedId === channel.id ? 'page' : undefined}
            className={`rounded px-3 py-2 text-left text-sm ${selectedId === channel.id ? 'bg-(--ui-surface-secondary) font-medium' : 'hover:bg-(--ui-surface-secondary)'}`}
            key={channel.id}
            onClick={() => onSelect(channel.id)}
            type="button"
          >
            #{channel.name}
          </button>
        ))}
      </div>
    </nav>
  )
}
