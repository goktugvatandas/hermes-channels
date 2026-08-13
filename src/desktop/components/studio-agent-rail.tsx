import type { CrewMember, HermesProfile } from '../types'
import { MemberAvatar } from '../presentation'

export const STEWARD_ID = '__steward__'
export const LIMITS_ID = '__limits__'
export const SCHEDULES_ID = '__schedules__'

interface StudioAgentRailProps {
  profiles: HermesProfile[]
  members: Record<string, CrewMember>
  selected: string
  search: string
  onSearch(value: string): void
  onSelect(profile: string): void
  onCreate(): void
}

function displayName(profile: HermesProfile, member?: CrewMember): string {
  const value = member?.displayName || profile.name
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

export function StudioAgentRail({ profiles, members, selected, search, onSearch, onSelect, onCreate }: StudioAgentRailProps) {
  const visible = profiles.filter((profile) => `${profile.name} ${profile.description} ${profile.provider} ${profile.model}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <nav aria-label="Agents" className="flex min-h-0 flex-col border-r border-(--ui-stroke-secondary) p-3">
      <div className="flex items-center justify-between gap-2 px-1"><h2 className="text-sm font-semibold">Agents</h2><button className="rounded-md px-2 py-1 text-xs font-medium text-(--ui-accent) transition-colors hover:bg-(--ui-accent)/10" onClick={(event) => { event.currentTarget.focus(); onCreate() }} type="button"><span aria-hidden="true">+ </span>New agent</button></div>
      <label className="mt-3 grid gap-1 text-xs text-(--ui-text-tertiary)"><span className="sr-only">Search agents</span><input aria-label="Search agents" className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm" onChange={(event) => onSearch(event.target.value)} placeholder="Search agents…" value={search} /></label>
      <div className="mt-3 grid content-start gap-1 overflow-auto">
        {visible.map((profile) => {
          const name = displayName(profile, members[profile.name])
          const role = members[profile.name]?.role
          return <button aria-current={selected === profile.name ? 'page' : undefined} aria-label={name} className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${selected === profile.name ? 'border-(--ui-accent)/40 bg-(--ui-accent)/10' : 'border-transparent hover:bg-(--ui-surface-secondary)'}`} key={profile.name} onClick={() => onSelect(profile.name)} type="button"><MemberAvatar profileId={profile.name} size="md" /><span className="min-w-0"><strong className="block truncate text-sm font-semibold">{name}</strong><span className="block truncate text-[11px] text-(--ui-text-tertiary)">{role || `${profile.model || 'Model not configured'} · ${profile.provider || 'Provider'}`}</span></span>{profile.gatewayRunning ? <span aria-label="Active" className="ml-auto size-2 shrink-0 rounded-full bg-green-500" /> : null}</button>
        })}
      </div>
      <div className="mt-auto border-t border-(--ui-stroke-secondary) px-1 pt-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Automation</h3>
        <button aria-current={selected === STEWARD_ID ? 'page' : undefined} className={`mt-1.5 flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${selected === STEWARD_ID ? 'border-(--ui-accent)/40 bg-(--ui-accent)/10' : 'border-transparent hover:bg-(--ui-surface-secondary)'}`} onClick={() => onSelect(STEWARD_ID)} type="button">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-(--ui-surface-secondary)"><span className="codicon codicon-settings-gear" style={{ width: 15, height: 15 }} /></span>
          <span className="min-w-0"><strong className="block truncate text-sm font-semibold">Steward</strong><span className="block truncate text-[11px] text-(--ui-text-tertiary)">Unblocks stalled handoffs</span></span>
        </button>
        <button aria-current={selected === SCHEDULES_ID ? 'page' : undefined} className={`mt-1 flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${selected === SCHEDULES_ID ? 'border-(--ui-accent)/40 bg-(--ui-accent)/10' : 'border-transparent hover:bg-(--ui-surface-secondary)'}`} onClick={() => onSelect(SCHEDULES_ID)} type="button">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-(--ui-surface-secondary)"><span className="codicon codicon-history" style={{ width: 15, height: 15 }} /></span>
          <span className="min-w-0"><strong className="block truncate text-sm font-semibold">Schedules</strong><span className="block truncate text-[11px] text-(--ui-text-tertiary)">Recurring crew kickoffs</span></span>
        </button>
        <button aria-current={selected === LIMITS_ID ? 'page' : undefined} className={`mt-1 flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${selected === LIMITS_ID ? 'border-(--ui-accent)/40 bg-(--ui-accent)/10' : 'border-transparent hover:bg-(--ui-surface-secondary)'}`} onClick={() => onSelect(LIMITS_ID)} type="button">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-(--ui-surface-secondary)"><span className="codicon codicon-git-compare" style={{ width: 15, height: 15 }} /></span>
          <span className="min-w-0"><strong className="block truncate text-sm font-semibold">Limits</strong><span className="block truncate text-[11px] text-(--ui-text-tertiary)">Loop budgets & concurrency</span></span>
        </button>
        <p className="mt-2 text-xs text-(--ui-text-tertiary)">{profiles.length} {profiles.length === 1 ? 'agent' : 'agents'}</p>
      </div>
    </nav>
  )
}
