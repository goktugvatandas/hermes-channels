import type { CrewChannel } from '../types'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'

interface ChannelHeaderProps {
  channel: CrewChannel
  /** Actual channel membership (profile ids), not the global roster. */
  memberIds: string[]
  onOpenDetails(): void
  pane?: 'chat' | 'board'
  onTogglePane?(): void
}

export function ChannelHeader({ channel, memberIds, onOpenDetails, pane = 'chat', onTogglePane }: ChannelHeaderProps) {
  const presentation = usePresentation()
  const project = channel.defaultProject?.mode === 'project'
    ? channel.defaultProject.label || channel.defaultProject.projectId
    : 'Global'
  const memberNames = memberIds.map((profileId) => presentedName(presentation, profileId))

  return (
    <header aria-label="Channel header" className="flex min-h-14 items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) px-5 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold">#{channel.name}</h2>
          <span className="shrink-0 rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary)">{project}</span>
        </div>
        <p className="truncate text-xs text-(--ui-text-secondary)">{channel.topic || channel.purpose || 'Shared channel'}</p>
      </div>
      {onTogglePane ? (
        <button
          aria-label={pane === 'board' ? 'Show conversation' : 'Show kanban board'}
          aria-pressed={pane === 'board'}
          className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium transition-colors hover:bg-(--ui-surface-secondary) ${pane === 'board' ? 'bg-(--ui-surface-secondary)' : ''}`}
          onClick={onTogglePane}
          type="button"
        >
          {pane === 'board' ? '💬 Chat' : '📋 Board'}
        </button>
      ) : null}
      <button
        aria-label={`Channel members: ${memberNames.join(', ')}`}
        className="flex shrink-0 items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) py-1 pl-1.5 pr-2.5 transition-colors hover:bg-(--ui-surface-secondary)"
        onClick={onOpenDetails}
        title={memberNames.join(', ')}
        type="button"
      >
        <span aria-hidden="true" className="flex -space-x-2">
          {memberIds.slice(0, 4).map((profileId) => (
            // Opaque backdrop per avatar: the shape faces are transparent
            // SVGs, so an overlapped stack shows through without one.
            <span className="flex items-center justify-center rounded-full bg-(--color-background) ring-2 ring-(--color-background)" key={profileId} title={presentedName(presentation, profileId)}><MemberAvatar profileId={profileId} size="sm" /></span>
          ))}
        </span>
        <span className="text-xs font-medium text-(--ui-text-secondary)">{memberIds.length}</span>
      </button>
    </header>
  )
}
