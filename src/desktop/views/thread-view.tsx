import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

import type { CrewApi } from '../api'
import { CrewComposer } from '../components/crew-composer'
import { IconButton } from '../components/icon-button'
import { MessageList } from '../components/message-list'
import { summarizeTurns, type TurnSummary } from '../conversation-model'
import type { CrewMessage, EventFrame, HermesProfile } from '../types'

interface ThreadViewProps {
  api: CrewApi
  channelId: string
  root: CrewMessage
  profiles: HermesProfile[]
  membershipRevision?: number
  events?: EventFrame[]
  onClose(): void
  returnFocusRef: RefObject<HTMLElement | null>
}

const THREAD_WIDTH_KEY = 'hermes-channels:thread-width'
const MIN_THREAD_WIDTH = 280
const MAX_THREAD_WIDTH = 640

function storedThreadWidth(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(THREAD_WIDTH_KEY))
    if (Number.isFinite(stored)) return Math.min(MAX_THREAD_WIDTH, Math.max(MIN_THREAD_WIDTH, stored))
  } catch {
    // Storage may be unavailable (private contexts); the default width is fine.
  }
  return 320
}

export function ThreadView({ api, channelId, root, profiles, membershipRevision = 0, events = [], onClose, returnFocusRef }: ThreadViewProps) {
  const [messages, setMessages] = useState<CrewMessage[]>([root])
  const [pendingTurnIds, setPendingTurnIds] = useState<string[]>([])
  const [width, setWidth] = useState(storedThreadWidth)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [memberIds, setMemberIds] = useState<string[]>([])

  useEffect(() => {
    let current = true
    void api.listChannelMembers(channelId)
      .then((members) => { if (current) setMemberIds(members.map((member) => member.profileId)) })
      .catch(() => undefined)
    return () => { current = false }
  }, [api, channelId, membershipRevision])
  const channelProfiles = useMemo(
    () => profiles.filter((profile) => memberIds.includes(profile.name)),
    [memberIds, profiles],
  )

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    function finish() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      setWidth((current) => {
        try { globalThis.localStorage?.setItem(THREAD_WIDTH_KEY, String(current)) } catch { /* non-fatal */ }
        return current
      })
    }
    function onMove(move: PointerEvent) {
      // Releases outside the window never deliver pointerup; a move with no
      // buttons down means the drag already ended.
      if (move.buttons === 0) { finish(); return }
      setWidth(Math.min(MAX_THREAD_WIDTH, Math.max(MIN_THREAD_WIDTH, startWidth + (startX - move.clientX))))
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    resizeCleanup.current = finish
  }

  // Unmounting mid-drag (Escape closes the pane) must not leave document
  // listeners behind.
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.() }, [])

  // Refetch replies whenever a turn started from this thread completes, so
  // agent answers appear without closing and reopening the pane.
  const threadRevision = useMemo(() => events.reduce((latest, event) => (
    event.type === 'completed' && event.turnId && pendingTurnIds.includes(event.turnId)
      ? Math.max(latest, event.sequence)
      : latest
  ), 0), [events, pendingTurnIds])

  useEffect(() => {
    let current = true
    void api.getThread(root.id).then((items) => { if (current) setMessages(items) })
    return () => { current = false }
  }, [api, root.id, threadRevision])

  useEffect(() => {
    headingRef.current?.focus()
    return () => { returnFocusRef.current?.focus() }
  }, [returnFocusRef])

  // Working indicator for turns triggered from this thread, mirroring the
  // channel timeline's pending rows.
  const pendingTurns = useMemo(() => {
    const summaries = new Map(summarizeTurns(events).map((turn) => [turn.turnId, turn]))
    return pendingTurnIds.map((turnId): TurnSummary => summaries.get(turnId) || {
      turnId,
      profileId: 'agent',
      state: 'queued',
      events: [],
      messageId: null,
      terminal: false,
      sessionId: null,
      triggerMessageId: null,
      triggerExcerpt: null,
    }).filter((turn) => !turn.terminal || (turn.messageId ? !messages.some((message) => message.id === turn.messageId) : false))
  }, [events, messages, pendingTurnIds])

  const turnByMessageId = useMemo(() => new Map(
    summarizeTurns(events)
      .filter((turn) => turn.messageId)
      .map((turn) => [turn.messageId as string, turn]),
  ), [events])

  const inheritedProject = root.project || { mode: 'inherit' as const }
  function close() {
    onClose()
  }
  return (
    <aside aria-label="Thread" aria-modal="true" className="absolute inset-y-0 right-0 z-10 flex min-h-0 max-w-[92cqw] flex-col bg-background transition-[opacity] duration-150 motion-reduce:transition-none @4xl:relative @4xl:z-auto" onKeyDown={(event) => { if (event.key === 'Escape') close() }} style={{ width }}>
      <div aria-hidden="true" className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize border-l border-(--ui-stroke-secondary) transition-colors hover:border-(--ui-accent) hover:bg-(--ui-accent)/25 active:border-(--ui-accent) active:bg-(--ui-accent)/25" onPointerDown={startResize} title="Drag to resize" />
      <header className="flex min-h-14 items-center justify-between border-b border-(--ui-stroke-secondary) py-2 pl-4 pr-2">
        <div className="min-w-0"><h2 className="text-sm font-semibold outline-none" ref={headingRef} tabIndex={-1}>Thread</h2>{root.project?.mode === 'project' ? <span className="block truncate text-[11px] text-(--ui-text-tertiary)">{root.project.label || root.project.projectId}</span> : null}</div>
        <IconButton codicon="close" label="Close thread" onClick={close} />
      </header>
      <MessageList messages={messages} pendingTurns={pendingTurns} profiles={profiles} thread turnByMessageId={turnByMessageId} />
      <CrewComposer
        api={api}
        channelId={channelId}
        fixedProject={inheritedProject}
        onSent={(receipt) => {
          setMessages((current) => [...current.filter((message) => message.id !== receipt.message.id), receipt.message])
          setPendingTurnIds((current) => [...new Set([...current, ...receipt.turnIds])])
        }}
        profiles={channelProfiles}
        rootMessageId={root.id}
      />
    </aside>
  )
}
