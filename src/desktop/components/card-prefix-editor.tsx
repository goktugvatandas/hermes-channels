import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { CardPrefixConfiguration } from '../types'

const VALID_PREFIX = /^[A-Z][A-Z0-9]{0,7}$/

/** Workspace board-prefix settings with generated defaults and explicit overrides. */
export function CardPrefixEditor({ api }: { api: CrewApi }) {
  const [items, setItems] = useState<CardPrefixConfiguration[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    void api.getCardPrefixes()
      .then((next) => {
        if (!current) return
        setItems(next)
        setDrafts(Object.fromEntries(next.map((item) => [item.boardSlug, item.prefix])))
      })
      .catch(() => { if (current) setError('Card prefixes could not be loaded') })
    return () => { current = false }
  }, [api])

  function apply(updated: CardPrefixConfiguration) {
    setItems((current) => current?.map((item) => (
      item.boardSlug === updated.boardSlug ? { ...item, ...updated } : item
    )) || null)
    setDrafts((current) => ({ ...current, [updated.boardSlug]: updated.prefix }))
  }

  function save(item: CardPrefixConfiguration) {
    const prefix = (drafts[item.boardSlug] || '').trim().toUpperCase()
    setStatus('')
    if (!VALID_PREFIX.test(prefix)) {
      setError('Start with a letter and use 1–8 letters or digits.')
      return
    }
    setError('')
    setBusy(item.boardSlug)
    void api.updateCardPrefix(item.boardSlug, prefix)
      .then((updated) => {
        apply(updated)
        const migrated = updated.migratedCards || 0
        setStatus(`${item.boardName} prefix saved.${migrated ? ` ${migrated} cards updated.` : ''}`)
      })
      .catch(() => setError(`${item.boardName} prefix could not be saved`))
      .finally(() => setBusy(null))
  }

  function reset(item: CardPrefixConfiguration) {
    setStatus('')
    setError('')
    setBusy(item.boardSlug)
    void api.updateCardPrefix(item.boardSlug, null)
      .then((updated) => {
        apply(updated)
        const migrated = updated.migratedCards || 0
        setStatus(`${item.boardName} now uses its automatic prefix.${migrated ? ` ${migrated} cards updated.` : ''}`)
      })
      .catch(() => setError(`${item.boardName} prefix could not be reset`))
      .finally(() => setBusy(null))
  }

  if (!items) {
    return (
      <section aria-label="Card prefixes" className="grid gap-3">
        <h3 className="text-sm font-semibold">Card prefixes</h3>
        <div aria-label="Loading card prefixes" className="h-24 animate-pulse rounded-xl bg-(--ui-surface-secondary)" />
        {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
      </section>
    )
  }

  return (
    <section aria-label="Card prefixes" className="grid content-start gap-4">
      <div>
        <h3 className="text-sm font-semibold">Card prefixes</h3>
        <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">
          Every board gets a prefix automatically. Edit it when the generated name does not match how you refer to that work area.
        </p>
      </div>
      <div className="grid gap-3">
        {items.map((item) => (
          <div className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) p-4" key={item.boardSlug}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <strong className="text-sm font-medium">{item.boardName}</strong>
                <p className="mt-0.5 text-[11px] text-(--ui-text-tertiary)">{item.boardSlug}</p>
              </div>
              <span className="rounded-full bg-(--ui-surface-secondary) px-2 py-1 text-[10px] font-medium text-(--ui-text-secondary)">
                Automatic: {item.generatedPrefix}
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid min-w-32 flex-1 gap-1 text-xs font-medium text-(--ui-text-secondary)">
                Prefix
                <input
                  aria-label={`${item.boardName} prefix`}
                  className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 font-mono text-sm uppercase text-foreground"
                  maxLength={8}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [item.boardSlug]: event.target.value.toUpperCase(),
                  }))}
                  value={drafts[item.boardSlug] ?? item.prefix}
                />
              </label>
              <button
                aria-label={`Save ${item.boardName} prefix`}
                className="rounded-lg bg-(--ui-accent) px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                disabled={busy === item.boardSlug}
                onClick={() => save(item)}
                type="button"
              >
                Save
              </button>
              {item.customized ? (
                <button
                  aria-label={`Use automatic prefix for ${item.boardName}`}
                  className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-2 text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50"
                  disabled={busy === item.boardSlug}
                  onClick={() => reset(item)}
                  type="button"
                >
                  Use automatic
                </button>
              ) : null}
            </div>
            {item.cardCount ? (
              <p className="text-[11px] text-(--ui-text-tertiary)">
                {item.cardCount} existing {item.cardCount === 1 ? 'card' : 'cards'} will be renamed when this prefix changes.
              </p>
            ) : (
              <p className="text-[11px] text-(--ui-text-tertiary)">No cards yet. The first card will use {drafts[item.boardSlug] || item.prefix}-1.</p>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span aria-live="polite" className="text-xs text-(--ui-text-tertiary)" role="status">{status}</span>
        {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
