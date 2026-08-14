import type { CrewMember, HermesProfile } from '../types'
import { MemberAvatar } from '../presentation'


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
    <nav aria-label="Bots" className="flex min-h-0 flex-col border-r border-(--ui-stroke-secondary) p-3">
      <div className="flex items-center justify-between gap-2 px-1"><h2 className="text-sm font-semibold">Bots</h2><button className="rounded-md px-2 py-1 text-xs font-medium text-(--ui-accent) transition-colors hover:bg-(--ui-accent)/10" onClick={(event) => { event.currentTarget.focus(); onCreate() }} type="button"><span aria-hidden="true">+ </span>New bot</button></div>
      <label className="mt-3 grid gap-1 text-xs text-(--ui-text-tertiary)"><span className="sr-only">Search bots</span><input aria-label="Search bots" className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm" onChange={(event) => onSearch(event.target.value)} placeholder="Search bots…" value={search} /></label>
      <div className="mt-3 grid content-start gap-1 overflow-auto">
        {visible.map((profile) => {
          const name = displayName(profile, members[profile.name])
          const role = members[profile.name]?.role
          return <button aria-current={selected === profile.name ? 'page' : undefined} aria-label={name} className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${selected === profile.name ? 'border-(--ui-accent)/40 bg-(--ui-accent)/10' : 'border-transparent hover:bg-(--ui-surface-secondary)'}`} key={profile.name} onClick={() => onSelect(profile.name)} type="button"><MemberAvatar profileId={profile.name} size="md" /><span className="min-w-0"><strong className="block truncate text-sm font-semibold">{name}</strong><span className="block truncate text-[11px] text-(--ui-text-tertiary)">{role || `${profile.model || 'Model not configured'} · ${profile.provider || 'Provider'}`}</span></span>{profile.gatewayRunning ? <span aria-label="Active" className="ml-auto size-2 shrink-0 rounded-full bg-green-500" /> : null}</button>
        })}
      </div>
      <div className="mt-auto border-t border-(--ui-stroke-secondary) px-1 pt-3">
        <p className="mt-2 text-xs text-(--ui-text-tertiary)">{profiles.length} {profiles.length === 1 ? 'bot' : 'bots'}</p>
      </div>
    </nav>
  )
}
