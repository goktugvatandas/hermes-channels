import { useRef } from 'react'

import { Avatar } from './avatar'

// Mirrors the identity palette in avatar.tsx so custom picks stay in family.
const SWATCHES = ['#5b4a9e', '#2f7d4a', '#b05c1d', '#22639e', '#b03a54', '#1f7a6d', '#8a6116', '#4c4f5e'] as const

interface AvatarEditorProps {
  name: string
  avatar: string | null
  color: string | null
  canGenerate?: boolean
  generating?: boolean
  onChange(patch: { avatar?: string | null; color?: string | null }): void
  onGenerate?(): void
}

/** Uploaded files become small square data URLs so they stay cheap to store. */
async function readAvatarFile(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('The image could not be read'))
    reader.readAsDataURL(file)
  })
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('The image could not be decoded'))
      element.src = dataUrl
    })
    const edge = Math.min(image.width, image.height)
    if (!edge) return dataUrl
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = Math.min(256, edge)
    const context = canvas.getContext('2d')
    if (!context) return dataUrl
    context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/webp', 0.85)
  } catch {
    return dataUrl
  }
}

export function AvatarEditor({ name, avatar, color, canGenerate, generating, onChange, onGenerate }: AvatarEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)

  async function upload(file: File | undefined) {
    if (!file) return
    onChange({ avatar: await readAvatarFile(file) })
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <Avatar color={color} name={name} size="lg" src={avatar} />
      <div className="grid min-w-0 gap-2.5">
        <div aria-label="Avatar color" className="flex flex-wrap items-center gap-1.5" role="group">
          {SWATCHES.map((swatch) => (
            <button
              aria-label={`Use color ${swatch}`}
              aria-pressed={color === swatch}
              className={`size-6 rounded-full border-2 transition-transform hover:scale-110 ${color === swatch ? 'border-(--ui-accent)' : 'border-transparent'}`}
              key={swatch}
              onClick={() => onChange({ color: color === swatch ? null : swatch })}
              style={{ backgroundColor: swatch }}
              type="button"
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => fileInput.current?.click()} type="button">Upload image</button>
          {canGenerate ? (
            <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50" disabled={generating} onClick={onGenerate} type="button">
              {generating ? 'Generating…' : 'Generate from profile'}
            </button>
          ) : null}
          {avatar ? <button className="rounded-lg px-2.5 py-1 text-xs font-medium text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary)" onClick={() => onChange({ avatar: null })} type="button">Remove image</button> : null}
        </div>
        {generating ? <p className="text-xs text-(--ui-text-tertiary)">Hermes is painting this avatar from the agent&apos;s profile. This can take a minute.</p> : null}
        <input accept="image/*" className="hidden" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }} ref={fileInput} type="file" />
      </div>
    </div>
  )
}
