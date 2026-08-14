import { useState, type FormEvent } from 'react'

import { presentedName, usePresentation } from '../presentation'
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
  const [purpose, setPurpose] = useState('')
  const [defaultResponder, setDefaultResponder] = useState('')
  const [saving, setSaving] = useState(false)
  const presentation = usePresentation()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await onCreate({
        name: name.trim(),
        purpose: purpose.trim(),
        defaultResponderProfile: defaultResponder || null,
        members: profiles.map((profile) => ({
          profileId: profile.name,
          activationPolicy:
            profile.name === defaultResponder ? 'always' : 'mentioned',
        })),
      })
      setName('')
      setPurpose('')
      setDefaultResponder('')
      setCreating(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <nav aria-label="Channels" className="flex min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
          Channels
        </h2>
        <button className="rounded-md px-2 py-1 text-xs font-medium text-(--ui-accent) transition-colors hover:bg-(--ui-accent)/10" onClick={() => setCreating(!creating)} type="button">
          <span aria-hidden="true">+ </span>New channel
        </button>
      </div>
      {creating ? (
        <form className="grid gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary)/50 p-3" onSubmit={submit}>
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">
            Channel name
            <input className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2.5 py-1.5 font-normal text-foreground" onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">
            Description <span className="font-normal text-(--ui-text-tertiary)">(optional)</span>
            <input className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2.5 py-1.5 font-normal text-foreground" onChange={(event) => setPurpose(event.target.value)} placeholder="What this channel is for" value={purpose} />
          </label>
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">
            Default responder
            <select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1.5 font-normal text-foreground" onChange={(event) => setDefaultResponder(event.target.value)} value={defaultResponder}>
              <option value="">None</option>
              {profiles.map((profile) => <option key={profile.name} value={profile.name}>{presentedName(presentation, profile.name)}</option>)}
            </select>
          </label>
          <button className="rounded-lg bg-(--ui-accent) px-2 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={saving || !name.trim()} type="submit">
            Create channel
          </button>
        </form>
      ) : null}
      <div className="grid content-start gap-0.5 overflow-auto">
        {channels.map((channel) => (
          <button
            aria-current={selectedId === channel.id ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${selectedId === channel.id ? 'bg-(--ui-accent)/10 font-medium text-(--ui-accent)' : 'text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary) hover:text-foreground'}`}
            key={channel.id}
            onClick={() => onSelect(channel.id)}
            type="button"
          >
            <span className={selectedId === channel.id ? 'opacity-70' : 'text-(--ui-text-tertiary)'}>#</span>{channel.name}
          </button>
        ))}
      </div>
    </nav>
  )
}
