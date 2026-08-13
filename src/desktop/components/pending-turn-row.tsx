import { turnStateLabel, type TurnSummary } from '../conversation-model'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'
import type { HermesProfile } from '../types'

export function PendingTurnRow({ turn, profile }: { turn: TurnSummary; profile?: HermesProfile }) {
  const presentation = usePresentation()
  const name = profile?.name || turn.profileId
  const displayName = presentedName(presentation, name)
  const details = turn.events.filter((event) => event.type !== 'streaming')
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] px-5 py-3" data-turn-id={turn.turnId}>
      <MemberAvatar profileId={name} size="md" />
      <article className="min-w-0">
        <header className="flex items-baseline gap-2">
          <strong className="text-sm font-semibold">{displayName}</strong>
          {!turn.terminal ? <span aria-hidden="true" className="inline-flex gap-0.5 pl-0.5"><span className="size-1 animate-pulse rounded-full bg-(--ui-text-tertiary)" /><span className="size-1 animate-pulse rounded-full bg-(--ui-text-tertiary) [animation-delay:150ms]" /><span className="size-1 animate-pulse rounded-full bg-(--ui-text-tertiary) [animation-delay:300ms]" /></span> : null}
        </header>
        <p className={`text-sm ${turn.state === 'failed' ? 'text-red-500' : 'text-(--ui-text-secondary)'}`}>{turnStateLabel(turn.state)}</p>
        {details.length ? (
          <details className="mt-1 text-xs text-(--ui-text-tertiary)">
            <summary className="cursor-pointer">View activity</summary>
            <ol className="mt-1 grid gap-1">
              {details.map((event) => <li key={event.sequence}>{event.type}</li>)}
            </ol>
          </details>
        ) : null}
      </article>
    </li>
  )
}
