import type { CrewApi } from '../api'
import { CardPrefixEditor } from '../components/card-prefix-editor'
import { LimitsEditor } from '../components/limits-editor'

/** Workspace settings: one place for everything that isn't a bot or a channel. */
export function SettingsView({ api }: { api: CrewApi }) {
  return (
    <section aria-label="Settings" className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-2xl px-6 py-6 @container">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">
          Workspace-wide configuration. Bot identity, models, and skills live
          in Bot Management.
        </p>
        <div className="mt-6 grid gap-8">
          <CardPrefixEditor api={api} />
          <LimitsEditor api={api} />
        </div>
      </div>
    </section>
  )
}
