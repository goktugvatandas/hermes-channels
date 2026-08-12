import { useMemo, useState } from 'react'

import type { CrewApi } from '../api'
import type { EventFrame } from '../types'
import { ApprovalCard } from './approval-card'
import { ResultCard } from './result-card'
import { ToolActivity } from './tool-activity'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export function ActivityPanel({ api, events }: { api: CrewApi; events: EventFrame[] }) {
  const [announcement, setAnnouncement] = useState('')
  const [disabled, setDisabled] = useState<string[]>([])
  const groups = useMemo(() => {
    const result = new Map<string, { events: EventFrame[]; profile: string }>()
    for (const event of events) {
      if (!event.turnId) continue
      const current = result.get(event.turnId) || { events: [], profile: 'agent' }
      current.events.push(event)
      if (typeof event.payload.profileId === 'string') current.profile = event.payload.profileId
      result.set(event.turnId, current)
    }
    return [...result.entries()]
  }, [events])

  async function stop(turnId: string, profile: string) {
    setDisabled((current) => [...current, `stop:${turnId}`])
    await api.cancelTurn(turnId)
    setAnnouncement(`Stop requested for ${profile}`)
  }
  async function retry(turnId: string, profile: string) {
    setDisabled((current) => [...current, `retry:${turnId}`])
    await api.retryTurn(turnId)
    setAnnouncement(`Retry queued for ${profile}`)
  }

  return (
    <section aria-label="Activity" className="grid content-start gap-3 overflow-auto p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Activity</h2>
      {groups.map(([turnId, group]) => {
        const latest = group.events[group.events.length - 1]
        return (
          <article className="grid gap-2 rounded border border-(--ui-stroke-secondary) p-3" key={turnId}>
            <header className="flex items-center justify-between gap-2"><strong className="text-sm">{group.profile}</strong><span className="text-xs">{latest.type}</span></header>
            <ol className="flex flex-wrap gap-1">{group.events.map((event) => <li className="rounded bg-(--ui-surface-secondary) px-1.5 py-0.5 text-[11px]" key={event.sequence}>{event.type}</li>)}</ol>
            {group.events.flatMap((event) => Array.isArray(event.payload.reasons) ? event.payload.reasons.map((reason) => <span className="text-xs text-(--ui-text-tertiary)" key={`${event.sequence}:${String(reason)}`}>{String(reason)}</span>) : [])}
            {group.events.filter((event) => event.type === 'tool_started' || event.type === 'tool_finished').map((event) => <ToolActivity event={event} key={`tool:${event.sequence}`} />)}
            {group.events.filter((event) => TERMINAL.has(event.type)).map((event) => <ResultCard event={event} key={`result:${event.sequence}`} />)}
            {group.events.filter((event) => event.type === 'waiting_approval' && typeof event.payload.approvalId === 'string').map((event) => <ApprovalCard approvalId={String(event.payload.approvalId)} key={`approval:${event.sequence}`} onResolve={async (decision, note) => { await api.resolveApproval(String(event.payload.approvalId), { decision, note }); setAnnouncement(`${decision === 'approve' ? 'Approved' : 'Rejected'} for ${group.profile}`) }} prompt={String(event.payload.prompt || 'Hermes requests approval')} />)}
            <div className="flex gap-2 text-xs">
              {!TERMINAL.has(latest.type) ? <button aria-label={`Stop ${group.profile}`} disabled={disabled.includes(`stop:${turnId}`)} onClick={() => void stop(turnId, group.profile)} type="button">Stop</button> : <button aria-label={`Retry ${group.profile}`} disabled={disabled.includes(`retry:${turnId}`)} onClick={() => void retry(turnId, group.profile)} type="button">Retry</button>}
            </div>
          </article>
        )
      })}
      <p aria-live="polite" role="status" className="sr-only">{announcement}</p>
    </section>
  )
}
