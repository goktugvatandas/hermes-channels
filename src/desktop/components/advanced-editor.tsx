import { host, type RuntimeReadinessResult } from '@hermes/plugin-sdk'

import { ReadinessCard } from './readiness-card'

export function AdvancedEditor({ runtime }: { runtime: RuntimeReadinessResult | null }) {
  return (
    <section className="grid gap-5">
      <div><h3 className="text-sm font-semibold">Advanced</h3><p className="mt-1 text-xs text-(--ui-text-tertiary)">Runtime diagnostics and native Hermes configuration.</p></div>
      <ReadinessCard result={runtime} />
      <div className="grid gap-2 border-t border-(--ui-stroke-secondary) pt-4 text-xs"><button className="justify-self-start" onClick={() => host.navigate('/profiles')} type="button">Hermes Profiles</button><button className="justify-self-start" onClick={() => host.navigate('/settings')} type="button">Settings</button><button className="justify-self-start" onClick={() => host.navigate('/projects')} type="button">Projects</button></div>
    </section>
  )
}
