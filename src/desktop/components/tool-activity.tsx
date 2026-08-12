import type { EventFrame } from '../types'

export function ToolActivity({ event }: { event: EventFrame }) {
  const finished = event.type === 'tool_finished'
  const name = String(event.payload.name || event.payload.toolName || 'Tool')
  return (
    <details className="rounded border border-(--ui-stroke-secondary) p-2" open={!finished}>
      <summary className="cursor-pointer text-xs"><strong>{name}</strong> · {event.type}</summary>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-(--ui-text-secondary)">{JSON.stringify(event.payload, null, 2)}</pre>
    </details>
  )
}
