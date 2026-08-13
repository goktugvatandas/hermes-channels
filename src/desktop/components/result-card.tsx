import type { EventFrame } from '../types'

const TITLES: Record<string, string> = {
  completed: 'Result',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
}

export function ResultCard({ event }: { event: EventFrame }) {
  const payload = event.payload
  const files = Array.isArray(payload.changedFiles) ? payload.changedFiles.map(String) : []
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.map(String) : []
  return (
    <section className="grid gap-1.5 rounded-lg border border-(--ui-stroke-secondary) p-2.5 text-xs">
      <strong className="font-semibold">{TITLES[event.type] || event.type}{typeof payload.intent === 'string' ? <span className="ml-1.5 rounded-full bg-(--ui-surface-secondary) px-1.5 py-px text-[10px] font-medium text-(--ui-text-secondary)">{String(payload.intent)}</span> : null}</strong>
      {typeof payload.summary === 'string' && payload.summary ? <p className="text-(--ui-text-secondary)">{payload.summary}</p> : null}
      {typeof payload.error === 'string' && payload.error ? <p className="text-red-500">{payload.error}</p> : null}
      {artifacts.length ? <p><span className="text-(--ui-text-tertiary)">Artifacts:</span> {artifacts.join(', ')}</p> : null}
      {files.length ? (
        <div>
          <span className="text-(--ui-text-tertiary)">Changed files</span>
          <ul className="mt-0.5 grid gap-0.5">
            {files.slice(0, 6).map((file) => <li className="truncate font-mono text-[11px]" key={file}>{file}</li>)}
            {files.length > 6 ? <li className="text-(--ui-text-tertiary)">…and {files.length - 6} more</li> : null}
          </ul>
        </div>
      ) : null}
      {payload.verification ? <p><span className="text-(--ui-text-tertiary)">Verification:</span> {String(payload.verification)}</p> : null}
      {payload.blocker ? <p className="text-amber-600"><span className="text-(--ui-text-tertiary)">Blocked:</span> {String(payload.blocker)}</p> : null}
      <details><summary className="cursor-pointer text-(--ui-text-tertiary) hover:text-foreground">Raw payload</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-(--ui-surface-secondary) p-2 text-[10px] leading-4">{JSON.stringify(payload, null, 2)}</pre></details>
    </section>
  )
}
