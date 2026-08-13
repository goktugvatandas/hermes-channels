import type { ToolInvocation } from '../conversation-model'

export function ToolActivity({ invocation, turnTerminal }: { invocation: ToolInvocation; turnTerminal: boolean }) {
  // A settled turn cannot still be running a tool, even if the journal never
  // recorded the finish frame.
  const done = Boolean(invocation.finished) || turnTerminal
  const name = String(invocation.started.payload.name || invocation.started.payload.toolName || 'Tool')
  const payload = invocation.finished && invocation.finished !== invocation.started
    ? { ...invocation.started.payload, ...invocation.finished.payload }
    : invocation.started.payload
  return (
    <details className="rounded-lg border border-(--ui-stroke-secondary) p-2" open={!done}>
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs">
        <span aria-hidden="true" className={`size-1.5 rounded-full ${done ? 'bg-green-500' : 'bg-(--ui-accent) animate-pulse motion-reduce:animate-none'}`} />
        <strong className="font-semibold">{name}</strong>
        <span className="text-(--ui-text-tertiary)">{done ? 'finished' : 'running…'}</span>
      </summary>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-(--ui-surface-secondary) p-2 text-[10px] leading-4 text-(--ui-text-secondary)">{JSON.stringify(payload, null, 2)}</pre>
    </details>
  )
}
