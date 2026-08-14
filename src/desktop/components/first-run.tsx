import { useState } from 'react'

import type { CrewApi } from '../api'
import type { CrewChannel, HermesProfile } from '../types'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'

export function FirstRun({ api, profiles, onComplete }: { api: CrewApi; profiles: HermesProfile[]; onComplete(channel: CrewChannel): void }) {
  const presentation = usePresentation()
  const [responder, setResponder] = useState(profiles[0]?.name || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create() {
    if (!responder) return
    setBusy(true); setError('')
    try {
      const channel = await api.onboard({
        defaultResponderProfile: responder,
        profiles: profiles.map((profile) => profile.name),
      })
      onComplete(channel)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Channels setup failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="m-auto grid w-full max-w-lg gap-5 rounded-2xl border border-(--ui-stroke-secondary) bg-background p-8 text-center shadow-sm">
      <div className="mx-auto flex -space-x-3">
        {profiles.slice(0, 5).map((profile) => (
          <span className="rounded-full ring-2 ring-(--color-background)" key={profile.name}><MemberAvatar profileId={profile.name} size="lg" /></span>
        ))}
      </div>
      <div><h2 className="text-lg font-semibold">Meet your Hermes Channels</h2><p className="mt-1 text-sm text-(--ui-text-secondary)">Create a local #general channel and choose the profile that answers untagged messages.</p></div>
      <label className="grid gap-1.5 text-left text-xs font-medium text-(--ui-text-secondary)">Default responder<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setResponder(event.target.value)} value={responder}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{presentedName(presentation, profile.name)}</option>)}</select></label>
      <p className="text-xs text-(--ui-text-tertiary)">The optional classifier starts off. Other profiles respond when mentioned.</p>
      {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
      <button className="rounded-full bg-(--ui-accent) px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-50" disabled={busy || !responder} onClick={() => void create()} type="button">{busy ? 'Creating…' : 'Create workspace'}</button>
    </section>
  )
}
