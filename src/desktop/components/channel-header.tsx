import type { CrewChannel, HermesProfile } from '../types'
import { MemberAvatar } from '../presentation'

interface ChannelHeaderProps {
  channel: CrewChannel
  profiles: HermesProfile[]
  onOpenDetails(): void
}

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

export function ChannelHeader({ channel, profiles, onOpenDetails }: ChannelHeaderProps) {
  const project = channel.defaultProject?.mode === 'project'
    ? channel.defaultProject.label || channel.defaultProject.projectId
    : 'Global'

  return (
    <header aria-label="Channel header" className="flex min-h-14 items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) px-5 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold">#{channel.name}</h2>
          <span className="shrink-0 rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary)">{project}</span>
        </div>
        <p className="truncate text-xs text-(--ui-text-secondary)">{channel.topic || channel.purpose || 'Shared crew channel'}</p>
      </div>
      <button
        aria-label="Channel details"
        className="flex shrink-0 items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) py-1 pl-1.5 pr-2.5 transition-colors hover:bg-(--ui-surface-secondary)"
        onClick={onOpenDetails}
        type="button"
      >
        <span aria-hidden="true" className="flex -space-x-2">
          {profiles.slice(0, 4).map((profile) => (
            <span className="rounded-full ring-2 ring-(--color-background)" key={profile.name}><MemberAvatar profileId={profile.name} size="sm" /></span>
          ))}
        </span>
        <span className="text-xs font-medium text-(--ui-text-secondary)">{profiles.length}</span>
      </button>
    </header>
  )
}
