import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { CrewChannel, RoutingRulesConfig } from '../types'

const FIELDS: Array<{ key: keyof RoutingRulesConfig; label: string; hint: string; min: number; max: number }> = [
  { key: 'max_automated_turns', label: 'Automation budget', hint: 'Agent-to-agent turns allowed per conversation before the chain pauses for a human. A message from you resets it.', min: 0, max: 200 },
  { key: 'max_depth', label: 'Max chain depth', hint: 'How many agent messages may stack on one another before routing stops.', min: 0, max: 50 },
  { key: 'max_pair_repeats', label: 'Max pair repeats', hint: 'How often the same two agents may bounce a conversation between them.', min: 0, max: 50 },
  { key: 'max_concurrency', label: 'Max concurrent turns', hint: 'Agents allowed to work at the same time in one channel.', min: 1, max: 64 },
]

function RuleFields({ value, placeholder, onChange }: {
  value: Partial<RoutingRulesConfig>
  placeholder?: RoutingRulesConfig | null
  onChange(key: keyof RoutingRulesConfig, value: number | null): void
}) {
  return (
    <div className="grid gap-3 @xl:grid-cols-2">
      {FIELDS.map((field) => (
        <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)" key={field.key}>
          {field.label}
          <input
            className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground"
            max={field.max}
            min={field.min}
            onChange={(event) => {
              if (event.target.value === '') { onChange(field.key, null); return }
              const next = Number(event.target.value)
              if (Number.isInteger(next) && next >= field.min && next <= field.max) onChange(field.key, next)
            }}
            placeholder={placeholder ? String(placeholder[field.key]) : undefined}
            type="number"
            value={value[field.key] ?? ''}
          />
          <span className="font-normal text-(--ui-text-tertiary)">{field.hint}</span>
        </label>
      ))}
    </div>
  )
}

/** Workspace-wide routing budgets plus per-channel overrides. */
export function LimitsEditor({ api }: { api: CrewApi }) {
  const [defaults, setDefaults] = useState<RoutingRulesConfig | null>(null)
  const [channels, setChannels] = useState<CrewChannel[]>([])
  const [drafts, setDrafts] = useState<Record<string, Partial<RoutingRulesConfig>>>({})
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    void Promise.all([api.getRoutingDefaults(), api.listChannels()])
      .then(([nextDefaults, nextChannels]) => {
        if (!current) return
        setDefaults(nextDefaults)
        setChannels(nextChannels)
        setDrafts(Object.fromEntries(nextChannels.map((channel) => [
          channel.id,
          { ...(channel.routingRules as Partial<RoutingRulesConfig>) },
        ])))
      })
      .catch(() => { if (current) setError('Routing limits could not be loaded') })
    return () => { current = false }
  }, [api])

  function saveDefaults(key: keyof RoutingRulesConfig, value: number | null) {
    if (value === null || !defaults) return
    setError('')
    const next = { ...defaults, [key]: value }
    setDefaults(next)
    void api.updateRoutingDefaults({ [key]: value })
      .then((confirmed) => { setDefaults(confirmed); setStatus('Defaults saved') })
      .catch(() => setError('Defaults could not be saved'))
  }

  function saveChannel(channel: CrewChannel) {
    setError('')
    const draft = drafts[channel.id] || {}
    const cleaned = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value !== null && value !== undefined),
    )
    void api.patchChannel(channel.id, { routingRules: cleaned })
      .then(() => setStatus(`#${channel.name} saved`))
      .catch(() => setError(`#${channel.name} could not be saved`))
  }

  if (!defaults) {
    return <div aria-label="Loading limits" className="grid gap-3 p-6"><span className="h-5 w-40 animate-pulse rounded bg-(--ui-surface-secondary)" /><span className="h-24 animate-pulse rounded bg-(--ui-surface-secondary)" /></div>
  }

  return (
    <section aria-label="Routing limits" className="grid content-start gap-6">
      <div>
        <h3 className="text-sm font-semibold">Routing limits</h3>
        <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">
          Loop-safety budgets for agent-to-agent work. When a chain hits a
          limit it pauses until a human posts (which resets the budget) — the
          Steward reports budget-blocked wakes in its sweeps.
        </p>
      </div>
      <div className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) p-4 @container">
        <strong className="text-sm font-medium">Workspace defaults</strong>
        <RuleFields onChange={saveDefaults} value={defaults} />
      </div>
      {channels.map((channel) => (
        <div className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) p-4 @container" key={channel.id}>
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm font-medium">#{channel.name}</strong>
            <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => saveChannel(channel)} type="button">Save overrides</button>
          </div>
          <p className="text-xs text-(--ui-text-tertiary)">Empty fields inherit the workspace defaults shown as placeholders.</p>
          <RuleFields
            onChange={(key, value) => setDrafts((current) => ({
              ...current,
              [channel.id]: { ...current[channel.id], [key]: value ?? undefined },
            }))}
            placeholder={defaults}
            value={drafts[channel.id] || {}}
          />
        </div>
      ))}
      <div className="flex items-center gap-3">
        <span aria-live="polite" className="text-xs text-(--ui-text-tertiary)" role="status">{status}</span>
        {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
