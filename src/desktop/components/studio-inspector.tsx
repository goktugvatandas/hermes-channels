import { host, type RuntimeReadinessResult } from '@hermes/plugin-sdk'

import type { CrewMember, HermesProfile } from '../types'
import type { SaveState } from '../studio-save-coordinator'
import { SaveStatus } from './save-status'

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

export function StudioInspector({ profile, member, runtime, respondsIn, saveState, onRetry }: { profile: HermesProfile; member: CrewMember; runtime: RuntimeReadinessResult | null; respondsIn: string[]; saveState: SaveState; onRetry(): void }) {
  const name = titleCase(member.displayName || profile.name)
  return (
    <aside aria-label={`${name} at a glance`} className="hidden min-h-0 overflow-auto border-l border-(--ui-stroke-secondary) p-4 @5xl:block">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">At a glance</h3>
      <dl className="mt-3 grid gap-px overflow-hidden rounded-xl border border-(--ui-stroke-secondary) text-xs">
        {([
          ['Status', <span className="flex items-center gap-2" key="s"><span className={`size-2 rounded-full ${runtime?.ready ? 'bg-green-500' : 'bg-(--ui-text-tertiary)'}`} />{runtime ? runtime.ready ? 'Active' : runtime.reason || 'Not ready' : 'Checking…'}</span>],
          ['Model', profile.model || 'Not configured'],
          ['Provider', profile.provider || 'Not configured'],
          ['Skills', `${profile.skillCount} enabled`],
          ['Default project', member.defaultProject?.label || member.defaultProject?.projectId || 'Global'],
          ['Responds in', respondsIn.length ? respondsIn.join(', ') : 'Mentions only'],
        ] as const).map(([label, valueNode]) => (
          <div className="grid gap-0.5 bg-(--ui-surface-secondary)/40 px-3 py-2" key={label}>
            <dt className="text-[11px] text-(--ui-text-tertiary)">{label}</dt>
            <dd className="font-medium">{valueNode}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 px-1"><SaveStatus error={saveState.error} state={saveState.phase} />{saveState.phase === 'error' ? <button className="mt-2 text-xs font-medium text-(--ui-accent) hover:underline" onClick={onRetry} type="button">Retry save</button> : null}</div>
      <div className="mt-5 grid gap-1 border-t border-(--ui-stroke-secondary) pt-4 text-left text-xs">
        <h4 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Shortcuts</h4>
        <button className="rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-surface-secondary)" onClick={() => host.navigate('/profiles')} type="button">Hermes Profiles</button>
        <button className="rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-surface-secondary)" onClick={() => host.navigate('/settings')} type="button">Settings</button>
        <button className="rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-surface-secondary)" onClick={() => host.navigate('/projects')} type="button">Projects</button>
      </div>
    </aside>
  )
}
