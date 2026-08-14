import { host } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { CrewApi } from '../api'
import { MemberAvatar, presentedName, usePresentation } from '../presentation'
import { ThemedSelect } from './themed-select'
import type { KanbanBoardInfo, KanbanCard, KanbanCardStatus, KanbanSnapshot } from '../types'

interface KanbanBoardProps {
  api: CrewApi
  channelId: string
  /** Channel membership — the assignee choices for cards. */
  memberIds?: string[]
}

/** Displayed lanes; `todo` absorbs the rarely-hand-touched planning states. */
const LANES: Array<{ id: string; label: string; statuses: KanbanCardStatus[] }> = [
  { id: 'triage', label: 'Triage', statuses: ['triage'] },
  { id: 'todo', label: 'To Do', statuses: ['todo', 'scheduled'] },
  { id: 'ready', label: 'Ready', statuses: ['ready'] },
  { id: 'running', label: 'Running', statuses: ['running'] },
  { id: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
]

/** Compact relative age from a unix-seconds timestamp: "3d", "5h", "2m". */
function age(seconds: number | null | undefined): string {
  if (!seconds) return ''
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 3600) return `${Math.max(1, Math.floor(delta / 60))}m`
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`
  return `${Math.floor(delta / 86_400)}d`
}

function stamp(seconds: number | null | undefined): string {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-[10px] uppercase tracking-wide text-(--ui-text-tertiary)">{label}</dt>
      <dd className="truncate text-right text-[11px]" title={value}>{value}</dd>
    </div>
  )
}

const EMPTY_DRAFT = { title: '', body: '', assignee: '', priority: 0, triage: false }

const STATUS_TINT: Record<string, string> = {
  running: 'bg-blue-500/15 text-blue-400',
  blocked: 'bg-red-500/15 text-red-400',
  review: 'bg-amber-500/15 text-amber-400',
  done: 'bg-green-500/15 text-green-400',
}

function StatusChip({ status, blockKind }: { status: string; blockKind?: string | null }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TINT[status] || 'bg-(--ui-surface-secondary) text-(--ui-text-secondary)'}`}>
      {status}{blockKind ? ` · ${blockKind}` : ''}
    </span>
  )
}

/** Centered dialog over a dimmed backdrop; backdrop click and Escape close. */
function Modal({ label, onClose, wide, children }: {
  label: string
  onClose(): void
  wide?: boolean
  children: ReactNode
}) {
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <section
        aria-label={label}
        aria-modal="true"
        className={`fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] ${wide ? 'w-[min(44rem,94vw)]' : 'w-[min(34rem,92vw)]'} -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-(--ui-stroke-secondary) bg-(--color-background) shadow-2xl`}
        onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
        role="dialog"
      >
        {children}
      </section>
    </>
  )
}

export function KanbanBoard({ api, channelId, memberIds = [] }: KanbanBoardProps) {
  const presentation = usePresentation()
  const [snapshot, setSnapshot] = useState<KanbanSnapshot | null>(null)
  const [boards, setBoards] = useState<KanbanBoardInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null)
  const [editDraft, setEditDraft] = useState<{ title: string; body: string; priority: number } | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT })
  const [connectSlug, setConnectSlug] = useState('')

  const refresh = useCallback(() => {
    return api.channelKanban(channelId)
      .then((next) => {
        setSnapshot(next)
        if (next.boards) setBoards(next.boards)
        setError(null)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Board unavailable')
      })
  }, [api, channelId])

  useEffect(() => {
    setSnapshot(null)
    setOpenCard(null)
    setCreateOpen(false)
    setDraft({ ...EMPTY_DRAFT })
    void refresh()
    void api.listKanbanBoards(channelId).then(setBoards).catch(() => {})
    // Agents file and complete cards from their own sessions; poll so the
    // board stays honest while it is on screen without a dedicated socket.
    const interval = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(interval)
  }, [api, channelId, refresh])

  const cards = useMemo(() => snapshot?.cards || [], [snapshot])
  const byLane = useMemo(() => {
    const groups = new Map<string, KanbanCard[]>(LANES.map((lane) => [lane.id, []]))
    for (const card of cards) {
      const lane = LANES.find((candidate) => candidate.statuses.includes(card.status))
      if (lane) groups.get(lane.id)?.push(card)
    }
    return groups
  }, [cards])

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await refresh()
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  function submitCreate() {
    const title = draft.title.trim()
    if (!title) return
    const payload: { title: string; body?: string; assignee?: string; priority?: number; triage?: boolean } = { title }
    if (draft.body.trim()) payload.body = draft.body.trim()
    if (draft.assignee) payload.assignee = draft.assignee
    if (draft.priority) payload.priority = draft.priority
    if (draft.triage) payload.triage = true
    setDraft({ ...EMPTY_DRAFT })
    setCreateOpen(false)
    void act(() => api.createKanbanCard(channelId, payload))
  }

  function openDetails(card: KanbanCard) {
    setCommentDraft('')
    setEditDraft(null)
    setOpenCard(card)
    void api.getKanbanCard(channelId, card.id).then(setOpenCard).catch(() => {})
  }

  function closeDetails() {
    setOpenCard(null)
    setEditDraft(null)
  }

  function saveEdit() {
    if (!openCard || !editDraft || !editDraft.title.trim()) return
    void act(async () => {
      const updated = await api.editKanbanCard(channelId, openCard.id, {
        title: editDraft.title.trim(),
        body: editDraft.body,
        priority: editDraft.priority,
      })
      setOpenCard({ ...openCard, ...updated })
      setEditDraft(null)
    })
  }

  function sendComment() {
    if (!openCard) return
    const body = commentDraft.trim()
    if (!body) return
    setCommentDraft('')
    void act(async () => {
      const updated = await api.commentKanbanCard(channelId, openCard.id, body)
      setOpenCard(updated)
    })
  }

  function bindBoard(slug: string) {
    if (!slug) return
    void act(async () => {
      const next = await api.rebindKanbanBoard(channelId, slug)
      setSnapshot(next)
    })
  }

  const assigneeOptions = [
    { value: '__none__', label: 'Unassigned' },
    ...memberIds.map((profileId) => ({
      value: profileId,
      label: presentedName(presentation, profileId),
    })),
  ]

  // Only an explicit `bound: false` means unbound — a backend one release
  // behind omits the flag entirely, and treating that as unbound would make
  // every action look like a silent no-op.
  if (snapshot && snapshot.bound === false) {
    return (
      <div aria-label="Channel kanban setup" className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="grid w-full max-w-sm gap-4 rounded-xl border border-(--ui-stroke-secondary) p-6">
          <div>
            <h3 className="text-sm font-semibold">No board connected</h3>
            <p className="mt-1 text-xs text-(--ui-text-secondary)">This channel has no kanban board yet. Create one, or connect a board you already use.</p>
          </div>
          <button
            className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => bindBoard(snapshot.suggestedSlug || '')}
            type="button"
          >
            Create board “{snapshot.suggestedSlug}”
          </button>
          {(snapshot.boards || []).length ? (
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-wide text-(--ui-text-tertiary)">or connect an existing board</p>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ThemedSelect
                    ariaLabel="Existing board"
                    options={[
                      { value: '__none__', label: 'Choose a board…' },
                      ...(snapshot.boards || []).map((board) => ({ value: board.slug, label: board.name })),
                    ]}
                    onChange={(next) => setConnectSlug(next === '__none__' ? '' : next)}
                    value={connectSlug || '__none__'}
                  />
                </div>
                <button
                  className="shrink-0 rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50"
                  disabled={busy || !connectSlug}
                  onClick={() => bindBoard(connectSlug)}
                  type="button"
                >
                  Connect
                </button>
              </div>
            </div>
          ) : null}
          {error ? <p className="text-xs text-(--ui-text-danger,#c34043)" role="alert">{error}</p> : null}
        </div>
      </div>
    )
  }

  const drawerMeta: Array<[string, string]> = openCard ? [
    ['Card', openCard.id],
    ['Status', openCard.status + (openCard.blockKind ? ` (${openCard.blockKind})` : '')],
    ['Priority', String(openCard.priority ?? 0)],
    ['Created by', openCard.createdBy || '—'],
    ['Created', stamp(openCard.createdAt)],
    ...(openCard.startedAt ? [['Started', stamp(openCard.startedAt)] as [string, string]] : []),
    ...(openCard.completedAt ? [['Completed', stamp(openCard.completedAt)] as [string, string]] : []),
    ...(openCard.modelOverride ? [['Model', `${openCard.providerOverride ? `${openCard.providerOverride} / ` : ''}${openCard.modelOverride}`] as [string, string]] : []),
    ...(openCard.reasoningEffort ? [['Reasoning', openCard.reasoningEffort] as [string, string]] : []),
    ...(openCard.branchName ? [['Branch', openCard.branchName] as [string, string]] : []),
    ...(openCard.workspacePath ? [['Workspace', openCard.workspacePath] as [string, string]] : (openCard.workspaceKind && openCard.workspaceKind !== 'scratch' ? [['Workspace', openCard.workspaceKind] as [string, string]] : [])),
    ...(openCard.tenant ? [['Tenant', openCard.tenant] as [string, string]] : []),
    ...(openCard.skills?.length ? [['Skills', openCard.skills.join(', ')] as [string, string]] : []),
    ...(openCard.goalMode ? [['Goal mode', 'on'] as [string, string]] : []),
    ...(openCard.consecutiveFailures ? [['Failures', String(openCard.consecutiveFailures)] as [string, string]] : []),
    ...(openCard.parents?.length ? [['Depends on', openCard.parents.join(', ')] as [string, string]] : []),
    ...(openCard.children?.length ? [['Blocks', openCard.children.join(', ')] as [string, string]] : []),
  ] : []

  return (
    <div aria-label="Channel kanban board" className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-(--ui-stroke-secondary) px-5 py-2">
          {boards.length > 1 ? (
            <ThemedSelect
              ariaLabel="Connected board"
              className="h-6 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-[11px] text-(--ui-text-secondary)"
              onChange={(slug) => { if (slug !== snapshot?.boardSlug) bindBoard(slug) }}
              options={boards.map((board) => ({ value: board.slug, label: board.name }))}
              value={snapshot?.boardSlug || ''}
            />
          ) : (
            <span className="text-xs font-medium text-(--ui-text-secondary)">{snapshot?.boardName || ''}</span>
          )}
          <button
            className="ml-auto shrink-0 whitespace-nowrap rounded-lg border border-(--ui-stroke-secondary) px-3 py-1 text-xs font-medium transition-colors hover:bg-(--ui-surface-secondary)"
            onClick={() => setCreateOpen((open) => !open)}
            type="button"
          >
            ＋ New card
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded-lg border border-(--ui-stroke-secondary) px-3 py-1 text-xs font-medium transition-colors hover:bg-(--ui-surface-secondary)"
            onClick={() => {
              // The official Kanban page renders the host's current board;
              // switch it to this channel's board, then jump there for the
              // full established experience (dispatch, runs, attachments, …).
              void api.openKanbanBoard(channelId)
                .then(() => host.navigate('/kanban'))
                .catch(() => setError('Could not open the Kanban page. If Channels was just updated, quit and reopen Hermes (the backend reloads only on a full restart); also check the Kanban plugin is enabled in Settings ▸ Plugins.'))
            }}
            title="Open this board in the full Kanban page"
            type="button"
          >
            Open in Kanban ↗
          </button>
        </div>
        {createOpen ? (
          <Modal label="New card" onClose={() => { setCreateOpen(false); setDraft({ ...EMPTY_DRAFT }) }}>
          <form
            aria-label="New card form"
            className="grid gap-2 px-5 py-4"
            onSubmit={(event) => { event.preventDefault(); submitCreate() }}
          >
            <h3 className="text-sm font-semibold">New card</h3>
            <input
              aria-label="Card title"
              autoFocus
              className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-(--ui-text-secondary) focus:border-(--ui-stroke-primary)"
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="Title"
              value={draft.title}
            />
            <textarea
              aria-label="Card description"
              className="min-h-16 resize-y rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-(--ui-text-secondary) focus:border-(--ui-stroke-primary)"
              onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
              placeholder="Description — spec, context, links (optional)"
              value={draft.body}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-secondary)">
                Assignee
                <ThemedSelect
                  ariaLabel="Card assignee"
                  className="h-6 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-[11px]"
                  onChange={(next) => setDraft((current) => ({ ...current, assignee: next === '__none__' ? '' : next }))}
                  options={assigneeOptions}
                  value={draft.assignee || '__none__'}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-secondary)">
                Priority
                <input
                  aria-label="Card priority"
                  className="w-14 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-(--ui-stroke-primary)"
                  max={10}
                  min={-10}
                  onChange={(event) => setDraft((current) => ({ ...current, priority: Number(event.target.value) || 0 }))}
                  type="number"
                  value={draft.priority}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-secondary)" title="Park in triage for a specifier to flesh out before work starts">
                <input
                  checked={draft.triage}
                  onChange={(event) => setDraft((current) => ({ ...current, triage: event.target.checked }))}
                  type="checkbox"
                />
                Triage
              </label>
              <div className="ml-auto flex gap-2">
                <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs hover:bg-(--ui-surface-secondary)" onClick={() => { setCreateOpen(false); setDraft({ ...EMPTY_DRAFT }) }} type="button">Cancel</button>
                <button className="rounded-lg bg-(--ui-accent) px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50" disabled={busy || !draft.title.trim()} type="submit">Create</button>
              </div>
            </div>
          </form>
          </Modal>
        ) : null}
        {error ? (
          <p className="px-5 py-2 text-xs text-(--ui-text-danger,#c34043)" role="alert">{error}</p>
        ) : null}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 py-3">
          {LANES.map((lane) => {
            const laneCards = byLane.get(lane.id) || []
            if (!laneCards.length && (lane.id === 'triage' || lane.id === 'todo' || lane.id === 'review')) {
              // Empty planning lanes just eat width on a personal board.
              return null
            }
            return (
              <section
                aria-label={lane.label}
                className="flex w-60 shrink-0 flex-col rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary)/40"
                key={lane.id}
              >
                <header className="flex items-center justify-between px-3 py-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-(--ui-text-secondary)">{lane.label}</h3>
                  <span className="text-[11px] text-(--ui-text-secondary)">{laneCards.length}</span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {laneCards.map((card) => (
                    <button
                      className="rounded-lg border border-(--ui-stroke-secondary) bg-(--color-background) p-2.5 text-left transition-colors hover:border-(--ui-stroke-primary)"
                      key={card.id}
                      onClick={() => openDetails(card)}
                      type="button"
                    >
                      <p className="text-xs font-medium leading-snug">{card.title}</p>
                      {card.status === 'blocked' && card.lastFailureError ? (
                        <p className="mt-1 truncate text-[10px] text-(--ui-text-danger,#c34043)" title={card.lastFailureError}>{card.lastFailureError}</p>
                      ) : null}
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {card.assignee ? (
                          <span className="flex min-w-0 items-center gap-1" title={presentedName(presentation, card.assignee)}>
                            <MemberAvatar profileId={card.assignee} size="sm" />
                            <span className="truncate text-[10px] text-(--ui-text-secondary)">{presentedName(presentation, card.assignee)}</span>
                          </span>
                        ) : null}
                        {card.priority ? (
                          <span className="rounded bg-(--ui-surface-secondary) px-1 text-[10px] text-(--ui-text-secondary)">P{card.priority}</span>
                        ) : null}
                        {card.commentCount ? (
                          <span className="text-[10px] text-(--ui-text-secondary)">💬 {card.commentCount}</span>
                        ) : null}
                        <span className="ml-auto text-[10px] text-(--ui-text-tertiary)" title={stamp(card.createdAt)}>{age(card.completedAt || card.startedAt || card.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
      {openCard ? (
        <Modal label="Card details" onClose={closeDetails} wide>
          <header className="flex items-start justify-between gap-3 border-b border-(--ui-stroke-secondary) px-5 py-3.5">
            <div className="min-w-0 flex-1">
              {editDraft ? (
                <input
                  aria-label="Edit title"
                  autoFocus
                  className="w-full rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm font-semibold outline-none focus:border-(--ui-stroke-primary)"
                  onChange={(event) => setEditDraft((current) => current && ({ ...current, title: event.target.value }))}
                  value={editDraft.title}
                />
              ) : (
                <h3 className="text-base font-semibold leading-snug">{openCard.title}</h3>
              )}
              <div className="mt-1.5 flex items-center gap-2">
                <StatusChip blockKind={openCard.blockKind} status={openCard.status} />
                <span className="text-[11px] text-(--ui-text-tertiary)">{openCard.id}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {editDraft ? (
                <>
                  <button className="rounded-lg bg-(--ui-accent) px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50" disabled={busy || !editDraft.title.trim()} onClick={saveEdit} type="button">Save</button>
                  <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs hover:bg-(--ui-surface-secondary)" onClick={() => setEditDraft(null)} type="button">Cancel</button>
                </>
              ) : (
                <button
                  aria-label="Edit card"
                  className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs hover:bg-(--ui-surface-secondary)"
                  onClick={() => setEditDraft({ title: openCard.title, body: openCard.body || '', priority: openCard.priority || 0 })}
                  type="button"
                >
                  ✎ Edit
                </button>
              )}
              <button
                aria-label="Close card details"
                className="rounded px-1.5 text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary)"
                onClick={closeDetails}
                type="button"
              >
                ×
              </button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
            {editDraft ? (
              <>
                <textarea
                  aria-label="Edit description"
                  className="min-h-24 resize-y rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-(--ui-text-secondary) focus:border-(--ui-stroke-primary)"
                  onChange={(event) => setEditDraft((current) => current && ({ ...current, body: event.target.value }))}
                  placeholder="Description"
                  value={editDraft.body}
                />
                <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-secondary)">
                  Priority
                  <input
                    aria-label="Edit priority"
                    className="w-14 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-(--ui-stroke-primary)"
                    max={10}
                    min={-10}
                    onChange={(event) => setEditDraft((current) => current && ({ ...current, priority: Number(event.target.value) || 0 }))}
                    type="number"
                    value={editDraft.priority}
                  />
                </label>
              </>
            ) : openCard.body ? (
              <p className="whitespace-pre-wrap text-xs">{openCard.body}</p>
            ) : null}
            {openCard.blockReason ? (
              <p className="rounded-lg bg-(--ui-surface-secondary) p-2 text-xs"><span className="font-medium">Blocked:</span> {openCard.blockReason}</p>
            ) : null}
            {openCard.result ? (
              <p className="rounded-lg bg-(--ui-surface-secondary) p-2 text-xs"><span className="font-medium">Result:</span> {openCard.result}</p>
            ) : null}
            {openCard.lastFailureError ? (
              <p className="rounded-lg bg-(--ui-surface-secondary) p-2 text-xs text-(--ui-text-danger,#c34043)"><span className="font-medium">Last failure:</span> {openCard.lastFailureError}</p>
            ) : null}
            <label className="flex items-center justify-between gap-2 text-[11px] text-(--ui-text-secondary)">
              Assignee
              <ThemedSelect
                ariaLabel="Assignee"
                className="h-6 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-[11px]"
                onChange={(next) => void act(async () => setOpenCard(await api.assignKanbanCard(channelId, openCard.id, next === '__none__' ? null : next)))}
                options={assigneeOptions}
                value={openCard.assignee || '__none__'}
              />
            </label>
            <dl aria-label="Card metadata" className="grid gap-1 rounded-lg border border-(--ui-stroke-secondary) p-2.5">
              {drawerMeta.map(([label, value]) => <MetaRow key={label} label={label} value={value} />)}
            </dl>
            <div className="flex flex-wrap gap-1.5">
              {openCard.status !== 'done' ? (
                <button className="rounded-lg border border-(--ui-stroke-secondary) px-2 py-1 text-[11px] hover:bg-(--ui-surface-secondary)" disabled={busy} onClick={() => void act(async () => setOpenCard(await api.completeKanbanCard(channelId, openCard.id)))} type="button">Complete</button>
              ) : null}
              {openCard.status === 'blocked' ? (
                <button className="rounded-lg border border-(--ui-stroke-secondary) px-2 py-1 text-[11px] hover:bg-(--ui-surface-secondary)" disabled={busy} onClick={() => void act(async () => setOpenCard(await api.unblockKanbanCard(channelId, openCard.id)))} type="button">Unblock</button>
              ) : openCard.status !== 'done' ? (
                <button className="rounded-lg border border-(--ui-stroke-secondary) px-2 py-1 text-[11px] hover:bg-(--ui-surface-secondary)" disabled={busy} onClick={() => void act(async () => setOpenCard(await api.blockKanbanCard(channelId, openCard.id)))} type="button">Block</button>
              ) : null}
              <button className="rounded-lg border border-(--ui-stroke-secondary) px-2 py-1 text-[11px] text-(--ui-text-danger,#c34043) hover:bg-(--ui-surface-secondary)" disabled={busy} onClick={() => void act(async () => { await api.deleteKanbanCard(channelId, openCard.id); closeDetails() })} type="button">Delete</button>
            </div>
            <div className="flex flex-col gap-2">
              {(openCard.comments || []).map((comment) => (
                <div className="rounded-lg bg-(--ui-surface-secondary) p-2" key={comment.id}>
                  <p className="text-[10px] font-medium text-(--ui-text-secondary)">{comment.author} <span className="font-normal text-(--ui-text-tertiary)">{stamp(comment.createdAt)}</span></p>
                  <p className="whitespace-pre-wrap text-xs">{comment.body}</p>
                </div>
              ))}
            </div>
            {openCard.events?.length ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-[11px] text-(--ui-text-secondary)">History ({openCard.events.length})</summary>
                <ul className="mt-1.5 grid gap-1">
                  {[...openCard.events].reverse().map((event) => (
                    <li className="flex items-baseline justify-between gap-2 text-[11px]" key={event.id}>
                      <span className="truncate" title={event.payload ? JSON.stringify(event.payload) : undefined}>{event.kind}</span>
                      <span className="shrink-0 text-(--ui-text-tertiary)">{stamp(event.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <form
            className="flex gap-2 border-t border-(--ui-stroke-secondary) px-4 py-3"
            onSubmit={(event) => { event.preventDefault(); sendComment() }}
          >
            <input
              aria-label="Comment"
              className="min-w-0 flex-1 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1 text-xs outline-none placeholder:text-(--ui-text-secondary) focus:border-(--ui-stroke-primary)"
              onChange={(event) => setCommentDraft(event.target.value)}
              placeholder="Comment…"
              value={commentDraft}
            />
            <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs hover:bg-(--ui-surface-secondary) disabled:opacity-50" disabled={busy || !commentDraft.trim()} type="submit">Send</button>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
