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
import { fetchModelCatalog, type CatalogModel } from '../model-catalog'
import type { StudioSave } from '../studio-save-coordinator'
import type { HermesProfile } from '../types'
import { ModelSelect } from './model-select'

export function ModelEditor({ api, profile, onProfile, save }: { api: CrewApi; profile: HermesProfile; onProfile(profile: HermesProfile): void; save: StudioSave }) {
  const [provider, setProvider] = useState(profile.provider || '')
  const [model, setModel] = useState(profile.model || '')
  const [effort, setEffort] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  useEffect(() => { setProvider(profile.provider || ''); setModel(profile.model || '') }, [profile])
  useEffect(() => {
    let current = true
    void fetchModelCatalog().then((rows) => { if (current) setCatalog(rows) })
    return () => { current = false }
  }, [])
  const controller: ModelMenuController = {
    applyPreset: (preset, row) => { setProvider(row.provider); setModel(row.model); setEffort(preset.effort || '') },
    current: { effort, fast: false, model, provider },
    presetFor: () => ({}),
    select: (nextModel, nextProvider) => { setModel(nextModel); setProvider(nextProvider) },
    setOptions: (patch) => { if (patch.effort !== undefined) setEffort(patch.effort) },
  }
  return (
    <section className="grid gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Brain</h3>
      {catalog.length ? (
        <ModelSelect catalog={catalog} model={model} onChange={(next) => { setProvider(next.provider); setModel(next.model) }} provider={provider} />
      ) : (
        // The catalog is unreachable (gateway down, no configured providers):
        // free-form entry keeps the editor usable.
        <div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs">Provider<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setProvider(event.target.value)} value={provider} /></label><label className="grid gap-1 text-xs">Model<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setModel(event.target.value)} value={model} /></label></div>
      )}
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
      <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" disabled={!provider.trim() || !model.trim()} onClick={() => void save(`${profile.name}:model`, () => api.updateModel(profile.name, provider, model)).then((result) => { if (result.current) onProfile(result.value) })} type="button">Save model</button>
    </section>
  )
}
