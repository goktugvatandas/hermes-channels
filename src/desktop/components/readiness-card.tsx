import type { RuntimeReadinessResult } from '@hermes/plugin-sdk'

export function ReadinessCard({ result }: { result: RuntimeReadinessResult | null }) {
  return (
    <section className="rounded border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Diagnostics</h3>
      {!result ? <p className="mt-1 text-xs text-(--ui-text-tertiary)">Checking runtime readiness…</p> : result.ready ? <p className="mt-1 text-xs text-green-500">Ready to run</p> : <p className="mt-1 text-xs text-amber-500">{result.reason || 'Runtime is not ready'}</p>}
    </section>
  )
}
