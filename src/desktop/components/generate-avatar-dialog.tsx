import { useState } from 'react'

import type { AvatarGenerateOptions, ImageGenerationStatus } from '../types'

interface GenerateAvatarDialogProps {
  name: string
  status: ImageGenerationStatus
  onClose(): void
  onGenerate(options: AvatarGenerateOptions): void
}

/**
 * Asks for the generation model (the Hermes-configured one preselected — a
 * cheaper tier is one click away) and an optional custom prompt. An empty
 * prompt lets the backend paint from the profile; a custom one is enhanced
 * server-side with avatar framing.
 */
export function GenerateAvatarDialog({ name, status, onClose, onGenerate }: GenerateAvatarDialogProps) {
  const [model, setModel] = useState(status.defaultModel || status.models[0]?.id || '')
  const [prompt, setPrompt] = useState('')

  function submit() {
    onGenerate({ model: model || null, prompt: prompt.trim() || null })
    onClose()
  }

  return (
    <div aria-label="Generate avatar" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/40" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }} role="dialog">
      <div className="grid w-[26rem] max-w-[calc(100vw-2rem)] gap-4 rounded-xl border border-(--ui-stroke-secondary) bg-background p-5 shadow-xl">
        <div>
          <h2 className="font-semibold">Generate avatar</h2>
          <p className="mt-1 text-xs text-(--ui-text-tertiary)">Hermes paints a portrait for {name} with {status.provider || 'the configured image backend'}.</p>
        </div>
        {status.models.length ? (
          <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Image model
            <select autoFocus className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setModel(event.target.value)} value={model}>
              {status.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.display}{entry.id === status.defaultModel ? ' (default)' : ''}{entry.speed ? ` · ${entry.speed}` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Custom prompt (optional)
          <textarea
            className="min-h-20 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the look you want — Hermes refines it into an avatar brief. Leave empty to paint from the profile."
            value={prompt}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm hover:bg-(--ui-surface-secondary)" onClick={onClose} type="button">Cancel</button>
          <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white" onClick={submit} type="button">Generate</button>
        </div>
      </div>
    </div>
  )
}
