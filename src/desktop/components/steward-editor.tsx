import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { fetchModelCatalog, type CatalogModel } from '../model-catalog'
import type { StewardSettings } from '../types'
import { ModelSelect } from './model-select'

/**
 * Settings pane for the Steward: the hidden, off-by-default automation agent
 * that unblocks stalled chains (re-plans unserved recipients, retries
 * orphaned turns) on a schedule — rule-based, no model spend.
 */
export function StewardEditor({ api }: { api: CrewApi }) {
  const [settings, setSettings] = useState<StewardSettings | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])

  useEffect(() => {
    let current = true
    void fetchModelCatalog().then((rows) => { if (current) setCatalog(rows) })
    return () => { current = false }
  }, [])

  useEffect(() => {
    let current = true
    void api.getSteward().then((next) => { if (current) setSettings(next) }).catch(() => {
      if (current) setError('Steward settings could not be loaded')
    })
    return () => { current = false }
  }, [api])

  function apply(patch: Partial<StewardSettings> & { provider?: string | null; model?: string | null }) {
    setError('')
    setStatus('')
    void api.updateSteward(patch)
      .then((next) => { setSettings(next); setStatus('Saved') })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Save failed'))
  }

  async function sweepNow() {
    setSweeping(true)
    setError('')
    setStatus('')
    try {
      const result = await api.runStewardSweep()
      const blocked = result.blocked?.length ?? 0
      const total = result.replanned.length + result.retried.length + (result.judged?.length ?? 0)
      if (blocked > 0) {
        setStatus(`Sweep complete — ${blocked} wake${blocked === 1 ? ' is' : 's are'} loop-budget blocked. Post a message in the channel to reset the automation budget and continue the chain.`)
      } else {
        setStatus(total === 0
          ? 'Sweep complete — nothing was stuck'
          : `Sweep complete — unblocked ${result.replanned.length} handoff${result.replanned.length === 1 ? '' : 's'}, retried ${result.retried.length} turn${result.retried.length === 1 ? '' : 's'}${result.judged?.length ? `, asked the judgment model about ${result.judged.length} channel${result.judged.length === 1 ? '' : 's'}` : ''}`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sweep failed')
    } finally {
      setSweeping(false)
    }
  }

  if (!settings) {
    return <div aria-label="Loading steward" className="grid gap-3 p-6"><span className="h-5 w-40 animate-pulse rounded bg-(--ui-surface-secondary)" /><span className="h-24 animate-pulse rounded bg-(--ui-surface-secondary)" /></div>
  }

  return (
    <section aria-label="Steward settings" className="grid content-start gap-5">
      <div>
        <h3 className="text-sm font-semibold">The Steward</h3>
        <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">
          A hidden automation agent that unblocks stalled lifecycles: it re-plans
          messages whose named recipients never got a turn and retries orphaned
          interrupted turns. Rule-based — it costs no model tokens — and every
          action still respects the routing budgets.
        </p>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3 text-sm">
        <span><strong className="font-medium">Enable automatic sweeps</strong><span className="block text-xs text-(--ui-text-tertiary)">Runs whenever a Crew surface is open, at the interval below.</span></span>
        <input checked={settings.enabled} onChange={(event) => apply({ enabled: event.target.checked })} type="checkbox" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Sweep every (minutes)
          <input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" min={1} max={1440}
            onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1) apply({ intervalMinutes: value }) }}
            type="number" defaultValue={settings.intervalMinutes} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Consider stalled after (minutes)
          <input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" min={1} max={1440}
            onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1) apply({ stallMinutes: value }) }}
            type="number" defaultValue={settings.stallMinutes} />
        </label>
      </div>
      <div className="grid gap-2 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3">
        <div>
          <strong className="text-sm font-medium">Judgment model</strong>
          <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">
            Optional. With a model set, ambiguous stalls — nothing named,
            nothing running, conversation unfinished — get one cheap model
            call per message deciding whom to wake. Without one, the Steward
            stays purely rule-based.
          </p>
        </div>
        {settings.provider && settings.model ? null : <p className="text-xs font-medium text-(--ui-text-secondary)">Currently: rules only</p>}
        {catalog.length ? (
          <ModelSelect
            catalog={catalog}
            compact
            model={settings.model || ''}
            onChange={(next) => apply({ provider: next.provider, model: next.model })}
            provider={settings.provider || ''}
          />
        ) : null}
        {settings.provider && settings.model ? (
          <button className="justify-self-start text-xs font-medium text-(--ui-text-secondary) hover:underline" onClick={() => apply({ provider: null, model: null })} type="button">Switch back to rules only</button>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={sweeping} onClick={() => void sweepNow()} type="button">{sweeping ? 'Sweeping…' : 'Run sweep now'}</button>
        <span aria-live="polite" className="text-xs text-(--ui-text-tertiary)" role="status">{status}</span>
      </div>
      {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
    </section>
  )
}
