import { useEffect, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import { generateMythicalName } from '../name-generator'
import { mirrorAvatarToBotMode } from '../bot-mode-bridge'
import type { StudioSave } from '../studio-save-coordinator'
import type { AvatarGenerateOptions, CrewMember, HermesProfile, ImageGenerationStatus } from '../types'
import { AvatarEditor } from './avatar-editor'
import { GenerateAvatarDialog } from './generate-avatar-dialog'

export function ProfileEditor({ api, profile, member, onMember, save }: { api: CrewApi; profile: HermesProfile; member: CrewMember; onMember(member: CrewMember): void; save: StudioSave }) {
  const [description, setDescription] = useState(profile.description)
  const [displayName, setDisplayName] = useState(member.displayName)
  const [role, setRole] = useState(member.role)
  const [soul, setSoul] = useState('')
  const [identityDirty, setIdentityDirty] = useState(false)
  const [soulDirty, setSoulDirty] = useState(false)
  const [generation, setGeneration] = useState<ImageGenerationStatus | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)

  useEffect(() => {
    let current = true
    void api.imageGenerationStatus()
      .then((status) => { if (current) setGeneration(status.available ? status : null) })
      .catch(() => { if (current) setGeneration(null) })
    return () => { current = false }
  }, [api])

  function saveAvatar(patch: { avatar?: string | null; color?: string | null }) {
    void save(`${profile.name}:avatar`, () => api.updateMember(profile.name, patch))
      .then((result) => {
        if (!result.current) return
        onMember(result.value)
        if ('avatar' in patch) mirrorAvatarToBotMode(profile.name, result.value.avatar)
      })
      .catch(() => undefined)
  }

  function generateAvatar(options: AvatarGenerateOptions) {
    setGenerating(true)
    void save(`${profile.name}:avatar`, () => api.generateMemberAvatar(profile.name, options))
      .then((result) => {
        if (!result.current) return
        onMember(result.value)
        mirrorAvatarToBotMode(profile.name, result.value.avatar)
      })
      .catch(() => undefined)
      .finally(() => setGenerating(false))
  }

  // Reset only when the SELECTED PROFILE changes. Keying this on the member
  // object would wipe in-progress edits (and cancel pending debounced saves)
  // every time any save resolves and hands back a fresh member object.
  const memberRef = useRef(member)
  memberRef.current = member
  useEffect(() => {
    setDescription(profile.description)
    setDisplayName(memberRef.current.displayName)
    setRole(memberRef.current.role)
    setIdentityDirty(false)
    setSoulDirty(false)
    let current = true
    void api.getSoul(profile.name).then((result) => { if (current) setSoul(result.content) })
    return () => { current = false }
  }, [api, profile.name])

  useEffect(() => {
    if (!identityDirty) return
    const profileName = profile.name
    const timer = setTimeout(() => {
      void save(`${profileName}:identity`, async () => {
        await api.updateProfile(profileName, { description })
        return api.updateMember(profileName, { displayName, role })
      }).then((result) => { if (result.current) { setIdentityDirty(false); onMember(result.value) } }).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [api, description, displayName, identityDirty, onMember, profile.name, role, save])

  useEffect(() => {
    if (!soulDirty) return
    const profileName = profile.name
    const timer = setTimeout(() => {
      void save(`${profileName}:soul`, () => api.updateSoul(profileName, soul)).then((result) => { if (result.current) setSoulDirty(false) }).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [api, profile.name, save, soul, soulDirty])

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div><h3 className="text-sm font-semibold">Avatar</h3><p className="mt-1 text-xs text-(--ui-text-tertiary)">Pick a color, upload an image{generation ? ', or let Hermes paint one from this profile' : ''}.</p></div>
        <AvatarEditor
          profileId={profile.name}
          avatar={member.avatar}
          canGenerate={Boolean(generation)}
          color={member.color}
          generating={generating}
          name={member.displayName || profile.name}
          onChange={saveAvatar}
          onGenerate={() => setGenerateOpen(true)}
        />
        {generateOpen && generation ? (
          <GenerateAvatarDialog
            name={member.displayName || profile.name}
            onClose={() => setGenerateOpen(false)}
            onGenerate={generateAvatar}
            status={generation}
          />
        ) : null}
      </section>
      <section className="grid gap-3 border-t border-(--ui-stroke-secondary) pt-5">
        <h3 className="text-sm font-semibold">Identity</h3>
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Display name
          <span className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => { setDisplayName(event.target.value); setIdentityDirty(true) }} value={displayName} />
            <button
              aria-label="Random mythological name"
              className="shrink-0 rounded-lg border border-(--ui-stroke-secondary) px-2.5 text-sm font-normal text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary)"
              onClick={() => { setDisplayName(generateMythicalName(displayName)); setIdentityDirty(true) }}
              title="Random mythological name"
              type="button"
            >
              <span aria-hidden="true" className="codicon codicon-sparkle" style={{ width: 14, height: 14 }} />
            </button>
          </span>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Role<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => { setRole(event.target.value); setIdentityDirty(true) }} value={role} /></label>
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Description<textarea className="min-h-20 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => { setDescription(event.target.value); setIdentityDirty(true) }} value={description} /></label>
      </section>
      <section className="grid gap-2 border-t border-(--ui-stroke-secondary) pt-5">
        <div><h3 className="text-sm font-semibold">SOUL summary</h3><p className="mt-1 text-xs text-(--ui-text-tertiary)">The agent's core operating essence and communication style.</p></div>
        <label className="grid gap-1 text-xs"><span className="sr-only">SOUL</span><textarea aria-label="SOUL" className="min-h-36 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 font-mono text-[13px] leading-5 text-foreground" onChange={(event) => { setSoul(event.target.value); setSoulDirty(true) }} value={soul} /></label>
      </section>
    </div>
  )
}
