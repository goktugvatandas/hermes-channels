import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { fetchModelCatalog, type CatalogModel } from '../model-catalog'
import type { StudioSave } from '../studio-save-coordinator'
import type { ActivationPolicy, ClassifierConfig, CrewChannel } from '../types'
import { ModelSelect } from './model-select'

interface ChannelBehavior {
  activation: ActivationPolicy
  classifier: ClassifierConfig
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
  enabled: false,
  provider: null,
  model: null,
  reasoningEffort: null,
  maxTokens: 300,
  confidenceThreshold: 0.65,
}

export function BehaviorEditor({ api, channels, profile, save: persist }: { api: CrewApi; channels: CrewChannel[]; profile: string; save: StudioSave }) {
  const [behavior, setBehavior] = useState<Record<string, ChannelBehavior>>({})
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  useEffect(() => {
    let current = true
    void fetchModelCatalog().then((rows) => { if (current) setCatalog(rows) })
    return () => { current = false }
  }, [])
  useEffect(() => {
    let current = true
    void Promise.all(channels.map(async (channel) => {
      const [members, classifier] = await Promise.all([api.listChannelMembers(channel.id), api.getClassifier(channel.id)])
      return [channel.id, { activation: members.find((member) => member.profileId === profile)?.activationPolicy || 'mentioned', classifier }] as const
    })).then((entries) => { if (current) setBehavior(Object.fromEntries(entries)) })
    return () => { current = false }
  }, [api, channels, profile])

  async function save() {
    await persist(`${profile}:behavior`, () => Promise.all(channels.flatMap((channel) => {
      const state = behavior[channel.id] || { activation: 'mentioned' as const, classifier: DEFAULT_CLASSIFIER }
      return [api.updateChannelMember(channel.id, profile, state.activation), api.updateClassifier(channel.id, state.classifier)]
    })))
  }

  return (
    <section className="grid gap-3 rounded-lg border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Behavior</h3>
      <p className="text-xs text-(--ui-text-tertiary)">The optional classifier is off unless enabled for a channel.</p>
      {channels.map((channel) => {
        const state = behavior[channel.id] || { activation: 'mentioned' as const, classifier: DEFAULT_CLASSIFIER }
        return <div className="grid gap-2 rounded bg-(--ui-surface-secondary) p-2" key={channel.id}>
          <strong className="text-xs">#{channel.name}</strong>
          <label className="grid gap-1 text-xs">Activation in #{channel.name}<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background p-1.5" onChange={(event) => setBehavior((current) => ({ ...current, [channel.id]: { ...state, activation: event.target.value as ActivationPolicy } }))} value={state.activation}><option value="always">Always respond</option><option value="mentioned">Mentions only</option><option value="observer">Observer</option><option value="disabled">Disabled</option></select></label>
          <label className="flex items-center gap-2 text-xs"><input aria-label="Use classifier" checked={state.classifier.enabled} onChange={(event) => setBehavior((current) => ({ ...current, [channel.id]: { ...state, classifier: { ...state.classifier, enabled: event.target.checked } } }))} type="checkbox" />Use separate classifier</label>
          {state.classifier.enabled ? (
            catalog.length ? (
              <ModelSelect
                catalog={catalog}
                compact
                labelPrefix="Classifier "
                model={state.classifier.model || ''}
                onChange={(next) => setBehavior((current) => ({ ...current, [channel.id]: { ...state, classifier: { ...state.classifier, provider: next.provider, model: next.model } } }))}
                provider={state.classifier.provider || ''}
              />
            ) : (
              <div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs">Classifier provider<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-1.5" onChange={(event) => setBehavior((current) => ({ ...current, [channel.id]: { ...state, classifier: { ...state.classifier, provider: event.target.value } } }))} value={state.classifier.provider || ''} /></label><label className="grid gap-1 text-xs">Classifier model<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-1.5" onChange={(event) => setBehavior((current) => ({ ...current, [channel.id]: { ...state, classifier: { ...state.classifier, model: event.target.value } } }))} value={state.classifier.model || ''} /></label></div>
            )
          ) : null}
        </div>
      })}
      <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" onClick={() => void save()} type="button">Save behavior</button>
    </section>
  )
}
