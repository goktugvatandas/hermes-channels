import { useState } from 'react'

import type { CrewApi } from '../api'
import type { CrewChannel, HermesProfile } from '../types'

export function FirstRun({ api, profiles, onComplete }: { api: CrewApi; profiles: HermesProfile[]; onComplete(channel: CrewChannel): void }) {
  const [responder, setResponder] = useState(profiles[0]?.name || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create() {
    if (!responder) return
    setBusy(true); setError('')
    try {
      const channel = await api.createChannel({
        name: 'general',
        purpose: 'Coordinate work with your Hermes crew',
        defaultResponderProfile: responder,
        defaultProject: { mode: 'global' },
        members: profiles.map((profile) => ({ profileId: profile.name, activationPolicy: profile.name === responder ? 'always' : 'mentioned' })),
      })
      await api.updateClassifier(channel.id, { enabled: false, provider: null, model: null, reasoningEffort: null, maxTokens: 300, confidenceThreshold: 0.65 })
      onComplete(channel)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Crew setup failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="m-auto grid max-w-lg gap-4 rounded border border-(--ui-stroke-secondary) p-6 text-center">
      <div><h2 className="text-lg font-semibold">Meet your Hermes Crew</h2><p className="mt-1 text-sm text-(--ui-text-secondary)">Create a local #general channel and choose the profile that answers untagged messages.</p></div>
      <label className="grid gap-1 text-left text-xs">Default responder<select className="rounded border border-(--ui-stroke-secondary) bg-background p-2" onChange={(event) => setResponder(event.target.value)} value={responder}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>
      <p className="text-xs text-(--ui-text-tertiary)">The optional classifier starts off. Other profiles respond when mentioned.</p>
      {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
      <button className="rounded bg-(--ui-accent) px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy || !responder} onClick={() => void create()} type="button">{busy ? 'Creating…' : 'Create Crew'}</button>
    </section>
  )
}
