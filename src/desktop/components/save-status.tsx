export type SavePhase = 'idle' | 'saving' | 'saved' | 'error'

export function SaveStatus({ state, error }: { state: SavePhase; error?: string | null }) {
  if (state === 'idle') return null
  return (
    <div className="flex items-center gap-2 text-xs text-(--ui-text-tertiary)" role="status">
      <span>{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : "Couldn't save"}</span>
      {state === 'error' && error ? <span className="text-red-500" role="alert">{error}</span> : null}
    </div>
  )
}
