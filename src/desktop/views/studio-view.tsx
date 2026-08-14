import { evaluateRuntimeReadiness, host, type RuntimeReadinessResult } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import type { CrewApi } from '../api'
import { AdvancedEditor } from '../components/advanced-editor'
import { BotAvatar } from '../components/shape-avatar'
import { BehaviorEditor } from '../components/behavior-editor'
import { CapabilityEditor } from '../components/capability-editor'
import { ModelEditor } from '../components/model-editor'
import { ProfileEditor } from '../components/profile-editor'
import { StudioAgentRail } from '../components/studio-agent-rail'
import { BOT_CREATE_EVENT, consumeBotCreate } from '../bot-create-signal'
import { StudioInspector } from '../components/studio-inspector'
import { StudioSectionNav, type StudioSection } from '../components/studio-section-nav'
import { WorkspaceEditor } from '../components/workspace-editor'
import { createSaveCoordinator, type SaveState, type StudioSave } from '../studio-save-coordinator'
import type { CrewChannel, CrewMember, HermesProfile } from '../types'

type ReadinessFn = (provider?: string | null) => Promise<RuntimeReadinessResult>

const EMPTY_MEMBER = (name: string): CrewMember => ({ profileId: name, displayName: name, role: '', avatar: null, color: null, defaultProject: null, archived: false })
const defaultReadiness: ReadinessFn = (provider) => evaluateRuntimeReadiness(host.request, { requestedProvider: provider || undefined })

export function StudioView({ api, readiness = defaultReadiness, onPresentationChange }: { api: CrewApi; readiness?: ReadinessFn; onPresentationChange?(): void }) {
  const [profiles, setProfiles] = useState<HermesProfile[]>([])
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [selected, setSelected] = useState('')
  const [members, setMembers] = useState<Record<string, CrewMember>>({})
  const [runtime, setRuntime] = useState<RuntimeReadinessResult | null>(null)
  const [respondsIn, setRespondsIn] = useState<string[]>([])
  const [section, setSection] = useState<StudioSection>('identity')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [noSkills, setNoSkills] = useState(false)
  const [cloneFrom, setCloneFrom] = useState('')
  const [diagnostic, setDiagnostic] = useState('')
  const [saveState, setSaveState] = useState<SaveState>({ phase: 'idle', error: null })
  const requestToken = useRef(0)
  const createTriggerRef = useRef<HTMLElement | null>(null)
  const restoreCreateFocus = useRef(false)
  const lastSaveKey = useRef('')
  const coordinator = useRef(createSaveCoordinator(setSaveState)).current
  const save = useCallback<StudioSave>((key, operation) => {
    lastSaveKey.current = key
    return coordinator.run(key, operation)
  }, [coordinator])

  useEffect(() => {
    let current = true
    void Promise.all([api.listProfiles(), api.listChannels()]).then(([nextProfiles, nextChannels]) => {
      if (!current) return
      setProfiles(nextProfiles)
      setChannels(nextChannels)
      setSelected((value) => value || nextProfiles[0]?.name || '')
    })
    return () => { current = false }
  }, [api])

  const profile = profiles.find((item) => item.name === selected) || null
  const member = selected ? members[selected] || null : null

  useEffect(() => {
    if (!selected) return
    const token = ++requestToken.current
    setDiagnostic('')
    void api.getMember(selected)
      .then((next) => { if (token === requestToken.current) setMembers((current) => ({ ...current, [selected]: next })) })
      .catch(() => { if (token === requestToken.current) setMembers((current) => ({ ...current, [selected]: EMPTY_MEMBER(selected) })) })
  }, [api, selected])

  useEffect(() => {
    if (!profile) return
    let current = true
    setRuntime(null)
    void readiness(profile.provider).then((result) => { if (current) setRuntime(result) }).catch((error: unknown) => { if (current) setRuntime({ ready: false, reason: error instanceof Error ? error.message : 'Readiness check failed', source: 'fallback', checksDisagree: false }) })
    return () => { current = false }
  }, [profile?.provider, readiness, selected])

  useEffect(() => {
    if (!selected) return
    let current = true
    void Promise.all(channels.map(async (channel) => ({ channel, members: await api.listChannelMembers(channel.id) }))).then((items) => {
      if (!current) return
      setRespondsIn(items.filter(({ members: channelMembers }) => channelMembers.some((item) => item.profileId === selected && item.activationPolicy === 'always')).map(({ channel }) => `#${channel.name}`))
    })
    return () => { current = false }
  }, [api, channels, selected])

  useEffect(() => {
    if (creating || !restoreCreateFocus.current) return
    restoreCreateFocus.current = false
    createTriggerRef.current?.focus()
  }, [creating])

  async function create(event: FormEvent) {
    event.preventDefault()
    setDiagnostic('')
    try {
      const created = await api.createProfile({ name: name.trim(), noSkills, cloneFrom: noSkills || !cloneFrom ? null : cloneFrom, cloneConfig: false, cloneAll: false, description: '' })
      setProfiles((current) => [...current, created])
      setSelected(created.name)
      setCreating(false)
      setName('')
      setNoSkills(false)
      setCloneFrom('')
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : 'Profile creation failed')
    }
  }

  useEffect(() => {
    // The pane's "+" asks for the create dialog: consume a fresh pending
    // request on mount, and react live when already mounted on this page.
    if (consumeBotCreate()) openCreate()
    const onRequest = () => { consumeBotCreate(); openCreate() }
    window.addEventListener(BOT_CREATE_EVENT, onRequest)
    return () => window.removeEventListener(BOT_CREATE_EVENT, onRequest)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-scoped handshake
  }, [])

  function openCreate() {
    createTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCreating(true)
  }

  function closeCreate() {
    restoreCreateFocus.current = true
    setCreating(false)
  }

  function retrySave() {
    if (lastSaveKey.current) void coordinator.retry(lastSaveKey.current).catch(() => undefined)
  }

  const editor = useMemo((): ReactNode => {
    if (!profile || !member) return <div aria-label="Loading agent" className="grid gap-3 p-6"><span className="h-5 w-40 animate-pulse rounded bg-(--ui-surface-secondary)" /><span className="h-28 animate-pulse rounded bg-(--ui-surface-secondary)" /></div>
    if (section === 'identity') return <section aria-label="Identity editor"><ProfileEditor api={api} member={member} onMember={(next) => { setMembers((current) => ({ ...current, [profile.name]: next })); onPresentationChange?.() }} profile={profile} save={save} /></section>
    if (section === 'model') return <section aria-label="Model editor"><ModelEditor api={api} onProfile={(next) => setProfiles((current) => current.map((item) => item.name === next.name ? next : item))} profile={profile} save={save} /></section>
    if (section === 'behavior') return <section aria-label="Behavior editor"><BehaviorEditor api={api} channels={channels} profile={profile.name} save={save} /></section>
    if (section === 'skills') return <section aria-label="Skills editor"><CapabilityEditor api={api} profile={profile.name} save={save} /></section>
    if (section === 'workspace') return <section aria-label="Workspace editor"><WorkspaceEditor api={api} channels={channels} member={member} onMember={(next) => { setMembers((current) => ({ ...current, [profile.name]: next })); onPresentationChange?.() }} profile={profile.name} save={save} /></section>
    return <section aria-label="Advanced editor"><AdvancedEditor runtime={runtime} /></section>
  }, [api, channels, member, onPresentationChange, profile, runtime, save, section])

  return (
    <section aria-label="Bot Management" className="grid min-h-0 flex-1 grid-cols-[200px_56px_minmax(0,1fr)] @3xl:grid-cols-[240px_150px_minmax(0,1fr)] @5xl:grid-cols-[240px_150px_minmax(0,1fr)_280px]">
      <StudioAgentRail members={members} onCreate={openCreate} onSearch={setSearch} onSelect={setSelected} profiles={profiles} search={search} selected={selected} />
      <>
      <StudioSectionNav onSelect={setSection} section={section} />
      <main className="min-h-0 overflow-auto">
        {profile ? <header className="flex min-h-16 items-center gap-3 border-b border-(--ui-stroke-secondary) px-6"><BotAvatar avatar={member?.avatar || null} color={member?.color || null} name={member?.displayName || profile.name} profileId={profile.name} size="md" /><h2 className="text-lg font-semibold">{member?.displayName || profile.name}</h2><span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600">Active</span><span className="rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-xs text-(--ui-text-secondary)">{profile.model} via {profile.provider}</span></header> : null}
        <div className="mx-auto max-w-2xl px-6 py-5">{editor}</div>
      </main>
      {profile && member ? <StudioInspector member={member} onRetry={retrySave} profile={profile} respondsIn={respondsIn} runtime={runtime} saveState={saveState} /> : null}
      </>
      {creating ? <div aria-label="Create Hermes profile" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/40" onKeyDown={(event) => { if (event.key === 'Escape') closeCreate() }} role="dialog"><form className="grid w-96 gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-background p-5 shadow-xl" onSubmit={create}><h2 className="font-semibold">Create Hermes profile</h2><label className="grid gap-1 text-xs">Profile name<input autoFocus className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setName(event.target.value)} value={name} /></label><label className="flex gap-2 text-xs"><input checked={noSkills} onChange={(event) => { setNoSkills(event.target.checked); if (event.target.checked) setCloneFrom('') }} type="checkbox" />Start without skills</label><label className="grid gap-1 text-xs">Copy skills from profile<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background p-2" disabled={noSkills} onChange={(event) => setCloneFrom(event.target.value)} value={cloneFrom}><option value="">Do not clone</option>{profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>{diagnostic ? <p className="text-xs text-amber-500" role="alert">{diagnostic}</p> : null}<div className="flex justify-end gap-2"><button className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm hover:bg-(--ui-surface-secondary)" onClick={closeCreate} type="button">Cancel</button><button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={!name.trim()} type="submit">Create</button></div></form></div> : null}
    </section>
  )
}
