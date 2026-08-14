import { host } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { CrewApi } from '../api'
import { Avatar } from '../components/avatar'
import { MemberAvatar } from '../presentation'
import { IconButton } from '../components/icon-button'
import { stripIntentMarkers } from '../intent-marker'
import { renderMarkdown } from '../markdown'
import type { SessionTranscript } from '../types'

interface SessionConsoleProps {
  api: CrewApi
  sessionId: string
  profileName?: string | null
  onClose(): void
}

interface LiveMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  streaming?: boolean
}

/**
 * Channel turn prompts embed the full routing context; keep it inspectable but
 * folded. COUPLING: mirrors the prompt shape produced by the backend's
 * context_builder.py ("## CHANNEL" first section, "message: [ts] author: …"
 * trigger line). Renderer degrades to a generic summary if that shape moves.
 */
function splitCrewContext(content: string): { context: string | null; visible: string } {
  if (!content.startsWith('## CHANNEL')) return { context: null, visible: content }
  const marker = content.lastIndexOf('\nmessage: ')
  if (marker === -1) return { context: content, visible: '(crew turn context)' }
  const line = content.slice(marker + 1).split('\n')[0]
  const visible = line.replace(/^message: \[\d+\] [^:]*: /, '') || '(crew turn context)'
  return { context: content, visible }
}

export function SessionConsole({ api, sessionId, profileName, onClose }: SessionConsoleProps) {
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null)
  const [error, setError] = useState('')
  const [live, setLive] = useState<LiveMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const runtimeRef = useRef<string | null>(null)
  const streamRef = useRef('')
  const flushRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    api.getSessionTranscript(sessionId)
      .then((next) => { if (current) { setTranscript(next); setError('') } })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : 'Transcript could not be loaded') })
    return () => { current = false }
  }, [api, sessionId])

  // Older Desktop SDK builds may not expose host.onEvent; the console then
  // falls back to polling the stored transcript after each send.
  const streamingSupported = typeof host.onEvent === 'function'

  useEffect(() => {
    if (!streamingSupported) return
    const offDelta = host.onEvent('message.delta', (event) => {
      if (!runtimeRef.current || event.session_id !== runtimeRef.current) return
      const payload = event.payload as { text?: string } | undefined
      if (typeof payload?.text === 'string') {
        streamRef.current += payload.text
        if (!flushRef.current) {
          flushRef.current = requestAnimationFrame(() => {
            flushRef.current = 0
            setStreamText(streamRef.current)
          })
        }
      }
    })
    const offComplete = host.onEvent('message.complete', (event) => {
      if (!runtimeRef.current || event.session_id !== runtimeRef.current) return
      const payload = event.payload as { text?: string; rendered?: string } | undefined
      const finalText = payload?.text || payload?.rendered || streamRef.current
      streamRef.current = ''
      setStreamText('')
      setBusy(false)
      if (finalText) setLive((current) => [...current, { role: 'assistant', content: finalText, createdAt: Date.now() }])
    })
    const offError = host.onEvent('message.error', (event) => {
      if (!runtimeRef.current || event.session_id !== runtimeRef.current) return
      streamRef.current = ''
      setStreamText('')
      setBusy(false)
      const payload = event.payload as { message?: string } | undefined
      setError(payload?.message || 'The session reported an error')
    })
    return () => { offDelta(); offComplete(); offError() }
  }, [streamingSupported])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [transcript, live, streamText])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      if (!runtimeRef.current) {
        const resumed = await host.request<{ session_id?: string }>('session.resume', {
          session_id: sessionId,
          source: 'desktop',
        })
        runtimeRef.current = resumed?.session_id || sessionId
      }
      setLive((current) => [...current, { role: 'user', content: text, createdAt: Date.now() }])
      setDraft('')
      await host.request('prompt.submit', { session_id: runtimeRef.current, text })
      if (!streamingSupported) pollForReply()
    } catch (reason) {
      setBusy(false)
      const message = reason instanceof Error ? reason.message : 'Message could not be sent to the session'
      setError(/gateway unavailable/i.test(message)
        ? 'The Hermes gateway is not connected — start it from Hermes, then try again.'
        : message)
    }
  }

  // Without gateway events, watch the stored transcript for the reply.
  function pollForReply() {
    const before = (transcript?.messages.length ?? 0)
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > 60) { clearInterval(timer); setBusy(false); return }
      void api.getSessionTranscript(sessionId).then((next) => {
        if (next.messages.length > before + 1) {
          clearInterval(timer)
          setTranscript(next)
          setLive([])
          setBusy(false)
        }
      }).catch(() => undefined)
    }, 2_000)
  }

  async function stop() {
    if (!runtimeRef.current) return
    try { await host.request('session.interrupt', { session_id: runtimeRef.current }) } catch { /* best effort */ }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const agentName = profileName ? `${profileName[0].toUpperCase()}${profileName.slice(1)}` : 'Agent'
  const rows = useMemo((): LiveMessage[] => [
    ...(transcript?.messages || []).map((message) => ({ role: message.role, content: message.content, createdAt: message.createdAt })),
    ...live,
  ], [transcript, live])

  return (
    <section aria-label="Agent session" className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) py-2 pl-5 pr-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {profileName ? <MemberAvatar profileId={profileName} size="md" /> : <Avatar name={agentName} size="md" />}
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{transcript?.title || 'Session'}</h2>
            <p className="truncate text-xs text-(--ui-text-secondary)">{agentName}{transcript?.model ? ` · ${transcript.model}` : ''} · direct session</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy ? <button className="rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => void stop()} type="button">Stop</button> : null}
          <IconButton codicon="close" label="Close session console" onClick={onClose} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-3" ref={scrollRef}>
        {error ? <p className="mb-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500" role="alert">{error}</p> : null}
        {!transcript && !error ? <p className="py-8 text-center text-sm text-(--ui-text-tertiary)">Loading session…</p> : null}
        <ol className="grid gap-3">
          {rows.map((message, index) => {
            const content = stripIntentMarkers(message.content)
            const { context, visible } = message.role === 'user' ? splitCrewContext(content) : { context: null, visible: content }
            const name = message.role === 'user' ? (context ? 'Channel' : 'You') : agentName
            return (
              <li className="grid grid-cols-[44px_minmax(0,1fr)] gap-0" key={`${message.createdAt}:${index}`}>
                <Avatar name={name} size="md" />
                <div className="min-w-0">
                  <header className="flex items-baseline gap-2">
                    <strong className="text-sm font-semibold">{name}</strong>
                    <time className="text-[11px] text-(--ui-text-tertiary)">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </header>
                  {context ? (
                    <details className="mt-0.5 text-sm">
                      <summary className="cursor-pointer text-(--ui-text-secondary) hover:text-foreground">{visible}</summary>
                      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-(--ui-surface-secondary) p-3 font-mono text-[11px] leading-4 text-(--ui-text-secondary)">{context}</pre>
                    </details>
                  ) : (
                    <div className="grid gap-1 text-sm leading-6 [overflow-wrap:anywhere]">{renderMarkdown(visible)}</div>
                  )}
                </div>
              </li>
            )
          })}
          {streamText ? (
            <li className="grid grid-cols-[44px_minmax(0,1fr)]">
              {profileName ? <MemberAvatar profileId={profileName} size="md" /> : <Avatar name={agentName} size="md" />}
              <div className="min-w-0">
                <strong className="text-sm font-semibold">{agentName}</strong>
                <div className="grid gap-1 text-sm leading-6 [overflow-wrap:anywhere]">{renderMarkdown(stripIntentMarkers(streamText))}</div>
              </div>
            </li>
          ) : busy ? (
            <li className="grid grid-cols-[44px_minmax(0,1fr)] items-center">
              {profileName ? <MemberAvatar profileId={profileName} size="md" /> : <Avatar name={agentName} size="md" />}
              <span aria-label={`${agentName} is responding`} className="inline-flex gap-1"><span className="size-1.5 animate-pulse rounded-full bg-(--ui-text-tertiary)" /><span className="size-1.5 animate-pulse rounded-full bg-(--ui-text-tertiary) [animation-delay:150ms]" /><span className="size-1.5 animate-pulse rounded-full bg-(--ui-text-tertiary) [animation-delay:300ms]" /></span>
            </li>
          ) : null}
        </ol>
      </div>
      <form aria-label="Session message" className="@container border-t border-(--ui-stroke-secondary) p-3" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <div className="rounded-2xl border border-(--ui-stroke-secondary) bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-(--ui-accent) focus-within:shadow-md">
          <label className="sr-only" htmlFor={`session-console-${sessionId}`}>Message</label>
          <textarea className="max-h-48 min-h-12 w-full resize-none bg-transparent px-4 py-2.5 text-sm outline-none" id={`session-console-${sessionId}`} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={`Message ${agentName} directly…`} rows={1} value={draft} />
          <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
            <span aria-hidden="true" className="hidden pl-1 text-[11px] text-(--ui-text-tertiary) @xl:inline">Direct session — replies stay out of crew channels</span>
            <button className="ml-auto rounded-full bg-(--ui-accent) px-4 py-1.5 text-sm font-medium text-white shadow-sm transition-opacity disabled:opacity-40" disabled={busy || !draft.trim()} type="submit">Send</button>
          </div>
        </div>
      </form>
    </section>
  )
}
