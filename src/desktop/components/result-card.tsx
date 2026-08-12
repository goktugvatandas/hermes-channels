import type { EventFrame } from '../types'

export function ResultCard({ event }: { event: EventFrame }) {
  const payload = event.payload
  return (
    <section className="rounded border border-(--ui-stroke-secondary) p-2 text-xs">
      <strong>{event.type}</strong>
      {typeof payload.summary === 'string' ? <p className="mt-1">{payload.summary}</p> : null}
      {Array.isArray(payload.artifacts) ? <p className="mt-1">Artifacts: {payload.artifacts.map(String).join(', ')}</p> : null}
      {Array.isArray(payload.changedFiles) ? <p className="mt-1">Changed: {payload.changedFiles.map(String).join(', ')}</p> : null}
      {payload.verification ? <p className="mt-1">Verification: {String(payload.verification)}</p> : null}
      {payload.blocker ? <p className="mt-1">Blocked: {String(payload.blocker)}</p> : null}
      <details className="mt-2"><summary className="cursor-pointer">Inspect payload</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(payload, null, 2)}</pre></details>
    </section>
  )
}
