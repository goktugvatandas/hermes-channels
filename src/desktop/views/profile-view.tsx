import { useEffect, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import { AvatarEditor } from '../components/avatar-editor'
import { GenerateAvatarDialog } from '../components/generate-avatar-dialog'
import type { AvatarGenerateOptions, ImageGenerationStatus, UserIdentity } from '../types'

interface ProfileViewProps {
  api: CrewApi
  identity: UserIdentity
  onIdentityChange(identity: UserIdentity): void
}

/** The human user's profile: how you appear in channels. */
export function ProfileView({ api, identity, onIdentityChange }: ProfileViewProps) {
  const [displayName, setDisplayName] = useState(identity.displayName)
  const [avatar, setAvatar] = useState(identity.avatar)
  const [color, setColor] = useState(identity.color)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState<ImageGenerationStatus | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)

  useEffect(() => {
    // While the form is dirty, only sync the avatar (generation lands
    // through identity updates); resetting everything would eat keystrokes
    // typed while a background refresh or generation was in flight.
    if (dirtyRef.current) {
      setAvatar(identity.avatar)
      return
    }
    setDisplayName(identity.displayName)
    setAvatar(identity.avatar)
    setColor(identity.color)
    setDirty(false)
  }, [identity])

  useEffect(() => {
    let current = true
    void api.imageGenerationStatus()
      .then((next) => { if (current) setGeneration(next.available ? next : null) })
      .catch(() => { if (current) setGeneration(null) })
    return () => { current = false }
  }, [api])

  async function saveAll() {
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const next = await api.updateMe({ displayName: displayName.trim() || 'You', avatar, color })
      onIdentityChange(next)
      setDirty(false)
      setStatus('Profile saved')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your profile could not be saved')
    } finally {
      setSaving(false)
    }
  }

  function generate(options: AvatarGenerateOptions) {
    setGenerating(true)
    setError('')
    setStatus('')
    void api.generateMyAvatar(options)
      .then((next) => {
        onIdentityChange(next)
        setStatus('Avatar generated')
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Avatar generation failed'))
      .finally(() => setGenerating(false))
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section aria-label="Your profile" className="mx-auto grid w-full max-w-xl content-start gap-6 px-6 py-8">
        <div>
          <h2 className="text-lg font-semibold">Your profile</h2>
          <p className="mt-1 text-sm text-(--ui-text-secondary)">How you appear in channels.</p>
        </div>
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Display name<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => { setDisplayName(event.target.value); setDirty(true) }} value={displayName} /></label>
        <div className="grid gap-2">
          <p className="text-xs font-medium text-(--ui-text-secondary)">Avatar</p>
          <AvatarEditor
            avatar={avatar}
            canGenerate={Boolean(generation)}
            color={color}
            generating={generating}
            name={displayName || 'You'}
            onChange={(patch) => {
              if (patch.avatar !== undefined) setAvatar(patch.avatar)
              if (patch.color !== undefined) setColor(patch.color)
              setDirty(true)
            }}
            onGenerate={() => setGenerateOpen(true)}
          />
        </div>
        {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
        <div className="flex items-center justify-end gap-3">
          <span aria-live="polite" className="text-xs text-(--ui-text-tertiary)" role="status">{status}</span>
          <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={saving || !dirty} onClick={() => void saveAll()} type="button">{saving ? 'Saving…' : 'Save profile'}</button>
        </div>
        {generateOpen && generation ? (
          <GenerateAvatarDialog
            name={displayName || 'You'}
            onClose={() => setGenerateOpen(false)}
            onGenerate={generate}
            status={generation}
          />
        ) : null}
      </section>
    </div>
  )
}
