import type { HermesProfile } from '../types'

export function MemberRoster({ profiles }: { profiles: HermesProfile[] }) {
  return (
    <section aria-label="Crew members" className="grid content-start gap-2 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Members</h2>
      {profiles.map((profile) => (
        <article className="rounded border border-(--ui-stroke-secondary) p-3" key={profile.name}>
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm">{profile.name}</strong>
            <span aria-label={profile.gatewayRunning ? 'Gateway online' : 'Gateway offline'} className={`size-2 rounded-full ${profile.gatewayRunning ? 'bg-green-500' : 'bg-zinc-500'}`} />
          </div>
          <p className="mt-1 text-xs text-(--ui-text-secondary)">{profile.description || 'Hermes profile'}</p>
          <p className="mt-2 truncate text-[11px] text-(--ui-text-tertiary)">{profile.provider && profile.model ? `${profile.provider} · ${profile.model}` : 'Model not configured'}</p>
        </article>
      ))}
    </section>
  )
}
