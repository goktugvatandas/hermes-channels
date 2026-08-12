import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  ModelCatalogMenu,
  ModelMenuCloseContext,
  type ModelMenuController,
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { HermesProfile } from '../types'

export function ModelEditor({ api, profile, onProfile }: { api: CrewApi; profile: HermesProfile; onProfile(profile: HermesProfile): void }) {
  const [provider, setProvider] = useState(profile.provider || '')
  const [model, setModel] = useState(profile.model || '')
  const [effort, setEffort] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  useEffect(() => { setProvider(profile.provider || ''); setModel(profile.model || '') }, [profile])
  const controller: ModelMenuController = {
    applyPreset: (preset, row) => { setProvider(row.provider); setModel(row.model); setEffort(preset.effort || '') },
    current: { effort, fast: false, model, provider },
    presetFor: () => ({}),
    select: (nextModel, nextProvider) => { setModel(nextModel); setProvider(nextProvider) },
    setOptions: (patch) => { if (patch.effort !== undefined) setEffort(patch.effort) },
  }
  return (
    <section className="grid gap-2 rounded border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Brain</h3>
      <div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs">Provider<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setProvider(event.target.value)} value={provider} /></label><label className="grid gap-1 text-xs">Model<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setModel(event.target.value)} value={model} /></label></div>
      <DropdownMenu onOpenChange={setCatalogOpen} open={catalogOpen}>
        <DropdownMenuTrigger asChild>
          <button className="justify-self-start text-xs" type="button">Browse native Hermes model catalog</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-0">
          <ModelMenuCloseContext.Provider value={() => setCatalogOpen(false)}>
            <ModelCatalogMenu controller={controller} profile={profile.name} />
          </ModelMenuCloseContext.Provider>
        </DropdownMenuContent>
      </DropdownMenu>
      <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" disabled={!provider.trim() || !model.trim()} onClick={async () => onProfile(await api.updateModel(profile.name, provider, model))} type="button">Save model</button>
    </section>
  )
}
