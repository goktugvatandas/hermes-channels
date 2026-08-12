import type { CrewApi } from '../api'

export interface CrewPageProps {
  api: CrewApi
}

export function CrewPage({ api: _api }: CrewPageProps) {
  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-(--ui-stroke-secondary) px-5 py-4">
        <h1 className="text-base font-semibold">Hermes Crew</h1>
        <p className="mt-1 text-sm text-(--ui-text-secondary)">
          Persistent Hermes profiles working together in local channels.
        </p>
      </header>
      <section className="grid min-h-0 flex-1 place-items-center p-6">
        <p className="text-sm text-(--ui-text-tertiary)">
          Create a channel to assemble your crew.
        </p>
      </section>
    </main>
  )
}
