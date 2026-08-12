import { evaluateRuntimeReadiness, host, type RuntimeReadinessResult } from '@hermes/plugin-sdk'
import { useEffect, useState, type FormEvent } from 'react'

import type { CrewApi } from '../api'
import { BehaviorEditor } from '../components/behavior-editor'
import { CapabilityEditor } from '../components/capability-editor'
import { ModelEditor } from '../components/model-editor'
import { ProfileEditor } from '../components/profile-editor'
import { ReadinessCard } from '../components/readiness-card'
import { WorkspaceEditor } from '../components/workspace-editor'
import type { CrewChannel, CrewMember, HermesProfile } from '../types'

type ReadinessFn = (provider?: string | null) => Promise<RuntimeReadinessResult>

const EMPTY_MEMBER = (name: string): CrewMember => ({ profileId: name, displayName: name, role: '', avatar: null, color: null, defaultProject: null, archived: false })

const defaultReadiness: ReadinessFn = (provider) =>
  evaluateRuntimeReadiness(host.request, {
    requestedProvider: provider || undefined,
  })

export function StudioView({ api, readiness = defaultReadiness }: { api: CrewApi; readiness?: ReadinessFn }) {
  const [profiles, setProfiles] = useState<HermesProfile[]>([])
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [selected, setSelected] = useState('')
  const [member, setMember] = useState<CrewMember | null>(null)
  const [runtime, setRuntime] = useState<RuntimeReadinessResult | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [noSkills, setNoSkills] = useState(false)
  const [cloneFrom, setCloneFrom] = useState('')
  const [diagnostic, setDiagnostic] = useState('')

  useEffect(() => { void Promise.all([api.listProfiles(), api.listChannels()]).then(([nextProfiles, nextChannels]) => { setProfiles(nextProfiles); setChannels(nextChannels); setSelected((value) => value || nextProfiles[0]?.name || '') }) }, [api])
  const profile = profiles.find((item) => item.name === selected) || null
  useEffect(() => {
    if (!selected) return
    setMember(null); setRuntime(null); setDiagnostic('')
    void api.getMember(selected).then(setMember).catch(() => setMember(EMPTY_MEMBER(selected)))
  }, [api, selected])
  useEffect(() => {
    if (!profile) return
    setRuntime(null)
    void readiness(profile.provider).then(setRuntime).catch((error: unknown) => setRuntime({ ready: false, reason: error instanceof Error ? error.message : 'Readiness check failed', source: 'fallback', checksDisagree: false }))
  }, [profile?.provider, readiness, selected])

  async function create(event: FormEvent) {
    event.preventDefault()
    try {
      const created = await api.createProfile({ name: name.trim(), noSkills, cloneFrom: noSkills || !cloneFrom ? null : cloneFrom, cloneConfig: false, cloneAll: false, description: '' })
      setProfiles((current) => [...current, created]); setSelected(created.name); setCreating(false); setName(''); setNoSkills(false); setCloneFrom('')
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : 'Profile creation failed')
    }
  }

  return (
    <section aria-label="Crew Studio" className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
      <aside className="grid min-h-0 content-start gap-2 border-r border-(--ui-stroke-secondary) p-3">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Crew Studio</h2><button onClick={() => setCreating(true)} type="button">Create profile</button></div>
        {profiles.map((item) => <button aria-current={selected === item.name ? 'page' : undefined} className="rounded px-3 py-2 text-left text-sm hover:bg-(--ui-surface-secondary)" key={item.name} onClick={() => setSelected(item.name)} type="button">{item.name}</button>)}
      </aside>
      <div className="min-h-0 overflow-auto p-4">
        {profile && member ? <div className="mx-auto grid max-w-4xl gap-4">
          <header className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">{member.displayName}</h2><p className="text-xs text-(--ui-text-tertiary)">{profile.path}</p></div><div className="flex gap-2 text-xs"><button onClick={() => host.navigate('/profiles')} type="button">Hermes Profiles</button><button onClick={() => host.navigate('/settings')} type="button">Settings</button><button onClick={() => host.navigate('/projects')} type="button">Projects</button></div></header>
          <ProfileEditor api={api} member={member} onMember={setMember} profile={profile} />
          <ModelEditor api={api} onProfile={(next) => setProfiles((current) => current.map((item) => item.name === next.name ? next : item))} profile={profile} />
          <CapabilityEditor api={api} profile={profile.name} />
          <BehaviorEditor api={api} channels={channels} profile={profile.name} />
          <WorkspaceEditor api={api} channels={channels} member={member} onMember={setMember} profile={profile.name} />
          <ReadinessCard result={runtime} />
        </div> : <p className="text-sm text-(--ui-text-tertiary)">Select a Hermes profile.</p>}
        {diagnostic ? <p role="alert" className="mt-3 text-xs text-amber-500">{diagnostic}</p> : null}
      </div>
      {creating ? <div aria-label="Create Hermes profile" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/40" role="dialog"><form className="grid w-96 gap-3 rounded bg-background p-5 shadow-xl" onSubmit={create}><h2 className="font-semibold">Create Hermes profile</h2><label className="grid gap-1 text-xs">Profile name<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setName(event.target.value)} value={name} /></label><label className="flex gap-2 text-xs"><input checked={noSkills} onChange={(event) => { setNoSkills(event.target.checked); if (event.target.checked) setCloneFrom('') }} type="checkbox" />Start without skills</label><label className="grid gap-1 text-xs">Clone from<select className="rounded border border-(--ui-stroke-secondary) bg-background p-2" disabled={noSkills} onChange={(event) => setCloneFrom(event.target.value)} value={cloneFrom}><option value="">Do not clone</option>{profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label><div className="flex justify-end gap-2"><button onClick={() => setCreating(false)} type="button">Cancel</button><button disabled={!name.trim()} type="submit">Create</button></div></form></div> : null}
    </section>
  )
}
