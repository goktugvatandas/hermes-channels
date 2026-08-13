import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from 'react'

import { groupMessages, type DeliveryState, type TurnSummary } from '../conversation-model'
import type { CrewMessage, HermesProfile } from '../types'
import { MessageRow } from './message-row'
import { PendingTurnRow } from './pending-turn-row'

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

interface MessageListProps {
  messages: CrewMessage[]
  pendingTurns?: TurnSummary[]
  profiles?: HermesProfile[]
  loading?: boolean
  deliveryById?: Record<string, DeliveryState>
  onReply?(message: CrewMessage): void
  onRetry?(messageId: string): void
  initialScrollTop?: number
  onScrollTop?(scrollTop: number): void
  /** Thread panes show every message; channel timelines show roots only. */
  thread?: boolean
  /** Turn behind each agent message, for the message-menu activity view. */
  turnByMessageId?: Map<string, TurnSummary>
}

export function MessageList({ messages, pendingTurns = [], profiles = [], loading = false, deliveryById = {}, onReply, onRetry, initialScrollTop = -1, onScrollTop, thread = false, turnByMessageId }: MessageListProps) {
  const listRef = useRef<HTMLOListElement>(null)
  const stickToBottom = useRef(initialScrollTop < 0)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = initialScrollTop < 0 ? list.scrollHeight : initialScrollTop
    // A restored offset that already sits at the bottom keeps following new
    // messages; only a genuine scrolled-up position opts out. (Guard on a
    // measurable layout — jsdom reports zero heights.)
    if (list.scrollHeight > 0) {
      stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    }
  }, [initialScrollTop])
  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [messages, pendingTurns])
  const replies = new Map<string, number>()
  for (const message of messages) {
    if (message.rootMessageId) replies.set(message.rootMessageId, (replies.get(message.rootMessageId) || 0) + 1)
  }
  const presented = groupMessages(thread ? messages : messages.filter((message) => !message.rootMessageId), deliveryById)
  const rows: ReactNode[] = []
  let lastDay = ''
  for (const item of presented) {
    const day = new Date(item.message.createdAt).toDateString()
    if (day !== lastDay) {
      lastDay = day
      rows.push(
        <li className="relative my-2 px-4" key={`day:${day}`} role="presentation">
          <span aria-hidden="true" className="absolute inset-x-4 top-1/2 border-t border-(--ui-stroke-secondary)" />
          <span className="relative mx-auto block w-fit rounded-full border border-(--ui-stroke-secondary) bg-background px-3 py-0.5 text-xs font-medium text-(--ui-text-secondary)">{dayLabel(item.message.createdAt)}</span>
        </li>,
      )
    }
    rows.push(<MessageRow item={item} key={item.message.id} onReply={onReply} onRetry={onRetry} profile={profiles.find((profile) => profile.name === item.message.authorProfileId)} replyCount={replies.get(item.message.id) || 0} turn={turnByMessageId?.get(item.message.id)} />)
  }
  return (
    <ol
      aria-label="Messages"
      className="min-h-0 flex-1 content-start overflow-auto py-2"
      onScroll={(event: UIEvent<HTMLOListElement>) => {
        const list = event.currentTarget
        stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
        onScrollTop?.(list.scrollTop)
      }}
      ref={listRef}
    >
      {loading && !presented.length ? <li className="grid gap-3 px-4 py-5" aria-label="Loading messages"><span className="h-4 w-40 animate-pulse rounded bg-(--ui-surface-secondary)" /><span className="h-4 w-2/3 animate-pulse rounded bg-(--ui-surface-secondary)" /></li> : null}
      {!loading && !presented.length && !pendingTurns.length ? <li className="grid place-items-center px-6 py-16 text-center"><div><p className="text-sm font-medium">Start the conversation</p><p className="mt-1 text-xs text-(--ui-text-tertiary)">Mention an agent or message the channel's default responder.</p></div></li> : null}
      {rows}
      {pendingTurns.map((turn) => <PendingTurnRow key={turn.turnId} profile={profiles.find((profile) => profile.name === turn.profileId)} turn={turn} />)}
    </ol>
  )
}
