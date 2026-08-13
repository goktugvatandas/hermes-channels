import { MemberAvatar, presentedName, usePresentation } from '../presentation'
import type { HermesProfile } from '../types'

interface MemberRosterProps {
  profiles: HermesProfile[]
  /** Profiles with a live (non-terminal) turn right now. */
  activeProfileIds?: string[]
}

export function MemberRoster({ profiles, activeProfileIds = [] }: MemberRosterProps) {
  const presentation = usePresentation()
  return (
    <section aria-label="Crew members" className="grid content-start gap-1 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Members</h2>
      {profiles.map((profile) => {
        const working = activeProfileIds.includes(profile.name)
        const member = presentation.members[profile.name]
        const subtitle = member?.role?.trim() || profile.description || 'Crew member'
        return (
          <article className="flex items-center gap-2 rounded px-1 py-2 hover:bg-(--ui-surface-secondary)" key={profile.name}>
            <MemberAvatar profileId={profile.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <strong className="truncate text-sm">{presentedName(presentation, profile.name)}</strong>
                {working ? <span aria-label="Working now" className="size-2 rounded-full bg-green-500" title="Working now" /> : null}
              </div>
              <p className="truncate text-[11px] text-(--ui-text-tertiary)">{working ? 'Working now' : subtitle}</p>
            </div>
          </article>
        )
      })}
    </section>
  )
}
