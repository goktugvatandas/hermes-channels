import { useMemo, useState } from 'react'

import type { CrewApi } from '../api'
import { pairToolEvents, summarizeTurns, turnStateLabel } from '../conversation-model'
import { stripIntentMarkers } from '../intent-marker'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'
import { openAgentSession } from '../session-nav'
import type { EventFrame } from '../types'
import { ApprovalCard } from './approval-card'
import { IconButton } from './icon-button'
import { ResultCard } from './result-card'
import { ToolActivity } from './tool-activity'

// Human phrasing for journal event types; anything unknown gets un-snaked.
export function describeEvent(event: EventFrame): string | null {
  const payload = event.payload
  switch (event.type) {
    case 'queued': return 'Queued'
    case 'claimed': return 'Claimed by a worker'
    case 'started': return 'Session started'
    case 'streaming': return null // one frame per chunk; too noisy to list
    case 'session_info': return null
    case 'tool_started': return null // rendered richly by ToolActivity
    case 'tool_finished': return null
    case 'waiting_approval': return 'Waiting for approval'
    case 'approval_request': return 'Approval requested'
    case 'completed': return typeof payload.intent === 'string' ? `Completed · ${payload.intent}` : 'Completed'
    case 'failed': return typeof payload.error === 'string' ? `Failed · ${payload.error.slice(0, 80)}` : 'Failed'
    case 'cancelled': return 'Stopped'
    case 'interrupted': return 'Interrupted'
    case 'routing_decision': return typeof payload.disposition === 'string' ? `Routing · ${payload.disposition}` : 'Routing decided'
    default: {
      const words = event.type.replaceAll('_', ' ')
      return words ? `${words[0].toUpperCase()}${words.slice(1)}` : words
    }
  }
}

export function ActivityPanel({ api, events, onOpenConsole }: {
  api: CrewApi
  events: EventFrame[]
  /** Optional "stay in the workspace" alternative to the native session view. */
  onOpenConsole?(sessionId: string, profileId: string): void
}) {
  const [announcement, setAnnouncement] = useState('')
  const [disabled, setDisabled] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const presentation = usePresentation()
  const [visibleCount, setVisibleCount] = useState(5)
  // Newest activity first; older turns sit behind "Load more".
  const turns = useMemo(() => [...summarizeTurns(events)].sort((left, right) => {
    const lastOf = (turn: (typeof left)) => turn.events[turn.events.length - 1]?.sequence ?? 0
    return lastOf(right) - lastOf(left)
  }), [events])
  const visible = turns.slice(0, visibleCount)

  async function stop(turnId: string, profile: string) {
    setDisabled((current) => [...current, `stop:${turnId}`])
    try {
      await api.cancelTurn(turnId)
      setAnnouncement(`Stop requested for ${profile}`)
    } catch {
      // Re-enable so the action stays available after a transient failure.
      setDisabled((current) => current.filter((id) => id !== `stop:${turnId}`))
      setAnnouncement(`Stop failed for ${profile}`)
    }
  }
  async function retry(turnId: string, profile: string) {
    setDisabled((current) => [...current, `retry:${turnId}`])
    setMenuFor(null)
    try {
      await api.retryTurn(turnId)
      setAnnouncement(`Retry queued for ${profile}`)
    } catch {
      setDisabled((current) => current.filter((id) => id !== `retry:${turnId}`))
      setAnnouncement(`Retry failed for ${profile}`)
    }
  }

  return (
    <section aria-label="Activity" className="grid content-start gap-3 overflow-y-auto overflow-x-hidden p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Activity</h2>
      {visible.map((turn) => {
        const open = expanded.includes(turn.turnId)
        const steps = turn.events.map((event) => ({ event, label: describeEvent(event) })).filter((step) => step.label)
        // No overflow-hidden on the entry: it would clip the ⋯ dropdown. The
        // min-w-0 chain plus the section's overflow-x-hidden keep long
        // excerpts from widening the rail.
        return (
          <article className="grid min-w-0 gap-2 border-b border-(--ui-stroke-secondary) pb-3 last:border-b-0" key={turn.turnId}>
            {/* Identity and actions live on separate rows: a 300px rail
                cannot fit avatar + name + excerpt + three buttons side by
                side without clipping something. */}
            <header className="flex min-w-0 items-start gap-2">
              <span className="relative mt-0.5 shrink-0"><MemberAvatar profileId={turn.profileId} size="sm" /><span className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-(--color-background) ${turn.terminal ? turn.state === 'failed' ? 'bg-red-500' : 'bg-(--ui-text-tertiary)' : 'bg-green-500'}`} /></span>
              <div className="min-w-0">
                <p className="text-sm"><strong>{presentedName(presentation, turn.profileId)}</strong> <span className="text-(--ui-text-secondary)">{turnStateLabel(turn.state)}</span></p>
                {turn.triggerExcerpt ? <p className="mt-0.5 truncate border-l-2 border-(--ui-stroke-secondary) pl-2 text-xs italic text-(--ui-text-tertiary)" title={stripIntentMarkers(turn.triggerExcerpt)}>{stripIntentMarkers(turn.triggerExcerpt)}</p> : null}
              </div>
            </header>
            <div className="relative flex flex-wrap items-center gap-1.5">
              {!turn.terminal ? <button aria-label={`Stop ${turn.profileId}`} className="rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50" disabled={disabled.includes(`stop:${turn.turnId}`)} onClick={() => void stop(turn.turnId, turn.profileId)} type="button">Stop</button> : null}
              {turn.sessionId ? <button aria-label={`Open ${presentedName(presentation, turn.profileId)} session`} className="rounded-md bg-(--ui-accent)/10 px-2.5 py-1 text-xs font-medium text-(--ui-accent) transition-colors hover:bg-(--ui-accent)/20" onClick={() => openAgentSession(turn.sessionId!)} type="button">Open session</button> : null}
              {turn.terminal || turn.sessionId ? <IconButton aria-expanded={menuFor === turn.turnId} codicon="ellipsis" label={`More actions for ${turn.profileId}`} onClick={() => setMenuFor((current) => current === turn.turnId ? null : turn.turnId)} title="More actions" /> : null}
              {menuFor === turn.turnId ? (
                <div className="absolute left-0 top-full z-20 mt-1 grid min-w-44 rounded-xl border border-(--ui-stroke-secondary) bg-background p-1 shadow-lg" onKeyDown={(event) => { if (event.key === 'Escape') setMenuFor(null) }} role="menu">
                  {turn.sessionId ? <button className="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => { setMenuFor(null); openAgentSession(turn.sessionId!) }} role="menuitem" type="button">Open session</button> : null}
                  {turn.sessionId && onOpenConsole ? <button className="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => { setMenuFor(null); onOpenConsole(turn.sessionId!, turn.profileId) }} role="menuitem" type="button">Open in Crew console</button> : null}
                  {turn.terminal ? <button aria-label={`Retry ${turn.profileId}`} className="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50" disabled={disabled.includes(`retry:${turn.turnId}`)} onClick={() => void retry(turn.turnId, turn.profileId)} role="menuitem" type="button">Retry turn</button> : null}
                </div>
              ) : null}
            </div>
            <button aria-expanded={open} aria-label="View activity details" className="justify-self-start text-xs text-(--ui-text-secondary) hover:underline" onClick={() => setExpanded((current) => current.includes(turn.turnId) ? current.filter((id) => id !== turn.turnId) : [...current, turn.turnId])} type="button">{open ? 'Hide details' : 'View details'}</button>
            {open ? <div className="grid gap-2 border-l border-(--ui-stroke-secondary) pl-3">
              {steps.length ? (
                <ol className="grid gap-1">
                  {steps.map(({ event, label }) => (
                    <li className="flex items-baseline gap-2 text-[11px]" key={event.sequence}>
                      <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-px rounded-full bg-(--ui-text-tertiary)" />
                      <span className="text-(--ui-text-secondary)">{label}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {turn.events.flatMap((event) => Array.isArray(event.payload.reasons) ? event.payload.reasons.map((reason) => <span className="text-xs text-(--ui-text-tertiary)" key={`${event.sequence}:${String(reason)}`}>{String(reason)}</span>) : [])}
              {pairToolEvents(turn.events).map((invocation) => <ToolActivity invocation={invocation} key={`tool:${invocation.started.sequence}`} turnTerminal={turn.terminal} />)}
              {turn.events.filter((event) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(event.type)).map((event) => <ResultCard event={event} key={`result:${event.sequence}`} />)}
              {turn.events.filter((event) => event.type === 'waiting_approval' && typeof event.payload.approvalId === 'string').map((event) => <ApprovalCard approvalId={String(event.payload.approvalId)} key={`approval:${event.sequence}`} onResolve={async (decision, note) => { await api.resolveApproval(String(event.payload.approvalId), { decision, note }); setAnnouncement(`${decision === 'approve' ? 'Approved' : 'Rejected'} for ${turn.profileId}`) }} prompt={String(event.payload.prompt || 'Hermes requests approval')} />)}
            </div>
            : null}
          </article>
        )
      })}
      {turns.length > visibleCount ? (
        <button className="justify-self-start text-xs font-medium text-(--ui-accent) hover:underline" onClick={() => setVisibleCount((current) => current + 10)} type="button">
          Load more ({turns.length - visibleCount} older)
        </button>
      ) : null}
      <p aria-live="polite" role="status" className="sr-only">{announcement}</p>
    </section>
  )
}
