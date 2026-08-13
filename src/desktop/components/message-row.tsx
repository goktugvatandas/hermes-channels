import { memo, useEffect, useMemo, useRef, useState } from 'react'

import type { PresentedMessage, TurnSummary } from '../conversation-model'
import { stripIntentMarkers } from '../intent-marker'
import { describeEvent } from './activity-panel'
import { renderMarkdown } from '../markdown'
import { MemberAvatar, UserAvatar, mentionHandle, presentedName, usePresentation, type Presentation } from '../presentation'
import { openAgentSession } from '../session-nav'
import type { HermesProfile } from '../types'
import { Avatar } from './avatar'
import { IconButton } from './icon-button'

interface MessageRowProps {
  item: PresentedMessage
  profile?: HermesProfile
  replyCount: number
  onReply?(message: PresentedMessage['message']): void
  onRetry?(messageId: string): void
  /** Turn that produced this agent message, for the menu's activity view. */
  turn?: TurnSummary
}

function authorName(item: PresentedMessage, presentation: Presentation, profile?: HermesProfile): string {
  if (item.message.authorType === 'user') return presentation.me.displayName?.trim() || 'You'
  if (item.message.authorType === 'system') return 'System'
  const profileId = item.message.authorProfileId || profile?.name || 'Agent'
  return presentedName(presentation, profileId)
}

function MessageRowImpl({ item, profile, replyCount, onReply, onRetry, turn }: MessageRowProps) {
  const { message } = item
  const presentation = usePresentation()
  const name = authorName(item, presentation, profile)
  const content = stripIntentMarkers(message.content)
  const mentionable = useMemo(
    () => new Set([
      // Every crew member highlights, not only the routed mentions array —
      // a kickoff naming four members must not render three of them as
      // plain text. Both spellings work: profile id and display handle.
      ...Object.keys(presentation.members).flatMap((profileId) => [
        profileId.toLowerCase(),
        mentionHandle(presentation, profileId).toLowerCase(),
      ]),
      ...message.mentions.map((mention) => mention.toLowerCase()),
      ...message.mentions.map((mention) => mentionHandle(presentation, mention).toLowerCase()),
      'all',
    ]),
    [message.mentions, presentation],
  )
  const rendered = useMemo(() => renderMarkdown(content, { mentionable }), [content, mentionable])
  const time = new Date(message.createdAt)
  const shortTime = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const [copied, setCopied] = useState<'message' | 'id' | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const rowRef = useRef<HTMLLIElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Open upward for rows in the lower half of the scroll viewport so the
  // popover is never clipped by the timeline's overflow container.
  function toggleDetails() {
    const row = rowRef.current
    const scroller = row?.closest('[aria-label="Messages"]')
    if (row && scroller) {
      const rowRect = row.getBoundingClientRect()
      const scrollRect = scroller.getBoundingClientRect()
      setDropUp(rowRect.top - scrollRect.top > scrollRect.height / 2)
    }
    setDetailsOpen((open) => !open)
  }

  function copy(kind: 'message' | 'id', value: string) {
    void navigator.clipboard?.writeText(value)
    setCopied(kind)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), 1600)
  }

  return (
    <li
      className={`group relative grid grid-cols-[44px_minmax(0,1fr)] px-5 ${item.startsGroup ? 'pt-3 pb-1' : 'py-1'} hover:bg-(--ui-surface-secondary)/60`}
      data-group-start={item.startsGroup}
      onKeyDown={(event) => { if (event.key === 'Escape') setDetailsOpen(false) }}
      onMouseLeave={() => setDetailsOpen(false)}
      ref={rowRef}
    >
      <div className="pt-0.5">
        {item.startsGroup ? (
          message.authorType === 'user' ? <UserAvatar size="md" />
            : message.authorType === 'agent' ? <MemberAvatar profileId={message.authorProfileId || profile?.name || 'Agent'} size="md" />
              : <Avatar name={name} size="md" />
        ) : <time className="invisible pt-1 text-[10px] text-(--ui-text-tertiary) group-hover:visible">{shortTime}</time>}
      </div>
      <article className="min-w-0 pr-20">
        {item.startsGroup ? (
          <header className="flex flex-wrap items-baseline gap-x-2">
            <strong className="text-sm font-semibold">{name}</strong>
            <time className="text-[11px] text-(--ui-text-tertiary)" dateTime={time.toISOString()} title={time.toLocaleString()}>{shortTime}</time>
            {message.modelLabel ? <span className="rounded-full bg-(--ui-surface-secondary) px-1.5 py-px text-[10px] text-(--ui-text-tertiary)">{message.modelLabel}</span> : null}
          </header>
        ) : null}
        <div className="grid gap-1 text-sm leading-6 [overflow-wrap:anywhere]">{rendered}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs empty:hidden">
          {message.project?.mode === 'project' ? <span className="rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-tertiary)">{message.project.label || message.project.projectId}</span> : null}
          {replyCount > 0 && onReply ? <button aria-label={`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`} className="inline-flex items-center gap-1 rounded-full border border-(--ui-stroke-secondary) px-2 py-0.5 font-medium text-(--ui-accent) transition-colors hover:border-(--ui-accent) hover:bg-(--ui-accent)/10" onClick={(event) => { event.currentTarget.focus(); onReply(message) }} type="button"><span aria-hidden="true" className="codicon codicon-reply" style={{ width: 12, height: 12 }} />{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</button> : null}
          {item.deliveryState === 'sending' ? <span className="text-(--ui-text-tertiary)">Sending…</span> : null}
          {item.deliveryState === 'failed' ? <><span className="text-red-500">Not sent</span>{onRetry ? <button aria-label="Retry message" className="font-medium hover:underline" onClick={() => onRetry(message.id)} type="button">Retry</button> : null}</> : null}
        </div>
      </article>
      <div className="absolute -top-3 right-5 z-10 hidden items-center gap-0.5 rounded-lg border border-(--ui-stroke-secondary) bg-background p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
        {onReply ? <IconButton codicon="reply" label="Reply in thread" onClick={(event) => { event.currentTarget.focus(); onReply(message) }} title="Reply in thread" /> : null}
        <IconButton className={copied === 'message' ? 'text-green-600' : ''} codicon={copied === 'message' ? 'check' : 'copy'} label="Copy message" onClick={() => copy('message', content)} title={copied === 'message' ? 'Copied' : 'Copy message'} />
        <IconButton aria-expanded={detailsOpen} codicon="ellipsis" label="More message actions" onClick={(event) => { event.currentTarget.focus(); toggleDetails() }} title="Message details" />
      </div>
      {detailsOpen ? (
        <div aria-label="Message details" className={`absolute right-5 z-20 w-72 max-w-[calc(100%-2.5rem)] rounded-xl border border-(--ui-stroke-secondary) bg-background p-3 text-xs shadow-lg ${dropUp ? 'bottom-8' : 'top-4'}`} role="group">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-(--ui-text-tertiary)">Sent</dt><dd className="min-w-0 text-right">{time.toLocaleString()}</dd>
            <dt className="text-(--ui-text-tertiary)">Author</dt><dd className="min-w-0 truncate text-right">{name}{message.authorType === 'agent' && message.modelLabel ? ` · ${message.modelLabel}` : ''}</dd>
            {message.project?.mode === 'project' ? <><dt className="text-(--ui-text-tertiary)">Project</dt><dd className="min-w-0 truncate text-right">{message.project.label || message.project.projectId}</dd></> : null}
            <dt className="text-(--ui-text-tertiary)">ID</dt>
            <dd className="min-w-0">
              <code className="block break-all rounded bg-(--ui-surface-secondary) px-1.5 py-1 text-[10px] leading-4">{message.id}</code>
              <button className={`mt-1 font-medium ${copied === 'id' ? 'text-green-600' : 'text-(--ui-accent) hover:underline'}`} onClick={() => copy('id', message.id)} type="button">{copied === 'id' ? 'Copied' : 'Copy ID'}</button>
            </dd>
          </dl>
          {message.authorType === 'agent' && turn ? (
            <section aria-label="Message activity" className="mt-3 border-t border-(--ui-stroke-secondary) pt-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Activity</h3>
                {turn.sessionId ? <button className="shrink-0 rounded-md bg-(--ui-accent)/10 px-2 py-0.5 text-[11px] font-medium text-(--ui-accent) transition-colors hover:bg-(--ui-accent)/20" onClick={() => openAgentSession(turn.sessionId!)} type="button">Open session</button> : null}
              </div>
              <ol className="mt-1.5 grid max-h-40 gap-1 overflow-y-auto">
                {turn.events.map((event) => ({ event, label: describeEvent(event) })).filter((step) => step.label).map(({ event, label }) => (
                  <li className="flex items-baseline gap-2 text-[11px]" key={event.sequence}>
                    <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-px rounded-full bg-(--ui-text-tertiary)" />
                    <span className="min-w-0 text-(--ui-text-secondary) [overflow-wrap:anywhere]">{label}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}
      <span aria-live="polite" className="sr-only" role="status">{copied ? 'Copied to clipboard' : ''}</span>
    </li>
  )
}

// Channel timelines re-render on every poll tick; rows only need to update
// when their own message, delivery state, or turn progress changes. The turn
// map is rebuilt per poll, so compare turns by content, not identity.
export const MessageRow = memo(MessageRowImpl, (previous, next) => (
  previous.item === next.item &&
  previous.profile === next.profile &&
  previous.replyCount === next.replyCount &&
  previous.onReply === next.onReply &&
  previous.onRetry === next.onRetry &&
  previous.turn?.turnId === next.turn?.turnId &&
  previous.turn?.state === next.turn?.state &&
  (previous.turn?.events.length ?? 0) === (next.turn?.events.length ?? 0)
))
