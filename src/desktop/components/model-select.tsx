import { catalogProviders, type CatalogModel } from '../model-catalog'

interface ModelSelectProps {
  catalog: CatalogModel[]
  provider: string
  model: string
  compact?: boolean
  labelPrefix?: string
  onChange(next: { provider: string; model: string }): void
}

/**
 * Provider + model dropdowns fed by the live Hermes catalog, so switching
 * models can only produce combinations Hermes actually accepts. Values that
 * predate the catalog (or come from a custom endpoint) stay selectable as a
 * "current" option instead of being silently discarded.
 */
export function ModelSelect({ catalog, provider, model, compact, labelPrefix = '', onChange }: ModelSelectProps) {
  const providers = catalogProviders(catalog)
  const knownProvider = providers.some((entry) => entry.slug === provider)
  const models = catalog.filter((entry) => entry.provider === provider).map((entry) => entry.model)
  const knownModel = models.includes(model)
  const field = compact ? 'p-1.5' : 'p-2'

  function selectProvider(slug: string) {
    const first = catalog.find((entry) => entry.provider === slug)?.model || ''
    onChange({ provider: slug, model: first })
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="grid gap-1 text-xs">{labelPrefix}Provider
        <select className={`rounded-lg border border-(--ui-stroke-secondary) bg-background ${field}`} onChange={(event) => selectProvider(event.target.value)} value={provider}>
          {provider && !knownProvider ? <option value={provider}>{provider} (current)</option> : null}
          {!provider ? <option value="">Choose provider…</option> : null}
          {providers.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs">{labelPrefix}Model
        <select className={`rounded-lg border border-(--ui-stroke-secondary) bg-background ${field}`} onChange={(event) => onChange({ provider, model: event.target.value })} value={model}>
          {model && !knownModel ? <option value={model}>{model} (current)</option> : null}
          {!model ? <option value="">Choose model…</option> : null}
          {models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
    </div>
  )
}
