import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { CrewMember, HermesProfile } from '../types'

export function ProfileEditor({ api, profile, member, onMember }: { api: CrewApi; profile: HermesProfile; member: CrewMember; onMember(member: CrewMember): void }) {
  const [description, setDescription] = useState(profile.description)
  const [displayName, setDisplayName] = useState(member.displayName)
  const [role, setRole] = useState(member.role)
  const [soul, setSoul] = useState('')
  useEffect(() => {
    setDescription(profile.description); setDisplayName(member.displayName); setRole(member.role)
    void api.getSoul(profile.name).then((result) => setSoul(result.content))
  }, [api, member, profile])
  return (
    <div className="grid gap-3">
      <section className="grid gap-2 rounded border border-(--ui-stroke-secondary) p-3">
        <h3 className="text-sm font-semibold">Identity</h3>
        <label className="grid gap-1 text-xs">Display name<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setDisplayName(event.target.value)} value={displayName} /></label>
        <label className="grid gap-1 text-xs">Role<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setRole(event.target.value)} value={role} /></label>
        <label className="grid gap-1 text-xs">Description<textarea className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setDescription(event.target.value)} value={description} /></label>
        <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" onClick={async () => { await api.updateProfile(profile.name, { description }); onMember(await api.updateMember(profile.name, { displayName, role })) }} type="button">Save identity</button>
      </section>
      <section className="grid gap-2 rounded border border-(--ui-stroke-secondary) p-3">
        <h3 className="text-sm font-semibold">Knowledge · SOUL</h3>
        <label className="grid gap-1 text-xs">SOUL<textarea className="min-h-40 rounded border border-(--ui-stroke-secondary) bg-transparent p-2 font-mono" onChange={(event) => setSoul(event.target.value)} value={soul} /></label>
        <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" onClick={() => void api.updateSoul(profile.name, soul)} type="button">Save SOUL</button>
      </section>
    </div>
  )
}
