import { useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'

import type { CrewApi } from '../api'
import type { CrewMessage, HermesProfile, MessageReceipt, ProjectRef } from '../types'
import { MemberAvatar, mentionHandle, presentedName, usePresentation } from '../presentation'
import { ProjectMenu, projectChipLabel } from './project-menu'

// The highlight backdrop only aligns with the textarea while both use the
// exact same box typography; change them together, never separately.
const FIELD_TYPOGRAPHY = 'px-4 py-2.5 text-sm leading-6 [overflow-wrap:anywhere]'

interface CrewComposerProps {
  api: CrewApi
  channelId: string
  profiles: HermesProfile[]
  rootMessageId?: string | null
  fixedProject?: ProjectRef | null
  onPending?(message: CrewMessage): void
  onFailed?(messageId: string): void
  onSent(receipt: MessageReceipt, pendingMessageId: string): void
  value?: string
  onValueChange?(value: string): void
  onNavigate?(view: 'home' | 'channels' | 'workshop' | 'search' | 'profile' | 'settings'): void
}

interface PendingAttempt {
  body: Parameters<CrewApi['createMessage']>[1]
  message: CrewMessage
}

interface ActiveToken {
  kind: 'mention' | 'command'
  query: string
  start: number
}

interface CommandDef {
  name: string
  description: string
  run(): void
}

/** The @token or /command the caret is inside, if any. */
function tokenAtCaret(value: string, caret: number): ActiveToken | null {
  const before = value.slice(0, caret)
  const mention = /(^|[\s([{])@([\w-]*)$/.exec(before)
  if (mention) {
    return { kind: 'mention', query: mention[2].toLowerCase(), start: caret - mention[2].length - 1 }
  }
  const command = /^\/([\w-]*)$/.exec(before)
  if (command && value.startsWith('/')) {
    return { kind: 'command', query: command[1].toLowerCase(), start: 0 }
  }
  return null
}

export function CrewComposer({ api, channelId, profiles, rootMessageId = null, fixedProject, onPending, onFailed, onSent, value, onValueChange, onNavigate }: CrewComposerProps) {
  const [internalContent, setInternalContent] = useState('')
  const [project, setProject] = useState<ProjectRef>(fixedProject || { mode: 'inherit' })
  const presentation = usePresentation()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [failedAttempt, setFailedAttempt] = useState<PendingAttempt | null>(null)
  const [token, setToken] = useState<ActiveToken | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)

  const content = value === undefined ? internalContent : value
  const setContent = (next: string) => value === undefined ? setInternalContent(next) : onValueChange?.(next)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`
    if (overlayRef.current) overlayRef.current.style.height = textarea.style.height
  }, [content])

  function syncToken(nextValue: string) {
    const caret = textareaRef.current?.selectionStart ?? nextValue.length
    const next = tokenAtCaret(nextValue, caret)
    setToken(next)
    if (!next) setActiveIndex(0)
  }

  const mentionMatches = useMemo(() => {
    if (token?.kind !== 'mention') return []
    const named = profiles.filter((profile) => {
      const handle = mentionHandle(presentation, profile.name).toLowerCase()
      return handle.startsWith(token.query) || profile.name.toLowerCase().startsWith(token.query)
    })
    const everyone = 'all'.startsWith(token.query) && profiles.length > 1
      ? [{ name: 'all', description: 'Notify every member of this channel', provider: null, model: null } as unknown as HermesProfile]
      : []
    return [...named, ...everyone]
  }, [token, profiles, presentation])

  // Rebuilt every render on purpose: command handlers close over the current
  // draft and token; memoizing them would freeze stale closures (`/all` would
  // silently no-op).
  const scopeCommands: CommandDef[] = fixedProject ? [] : [
    { name: 'inherit', description: "Scope this message to the channel's project", run: () => setProject({ mode: 'inherit' }) },
    { name: 'global', description: 'Scope this message to global context', run: () => setProject({ mode: 'global' }) },
    { name: 'project', description: 'Attach a Hermes project to this message', run: () => setProject({ mode: 'project', profile: profiles[0]?.name || null }) },
  ]
  const navCommands: CommandDef[] = onNavigate ? [
    { name: 'home', description: 'Go to the Crew home', run: () => onNavigate('home') },
    { name: 'lab', description: 'Open the Bot Management', run: () => onNavigate('workshop') },
    { name: 'profile', description: 'Edit how you appear in channels', run: () => onNavigate('profile') },
    { name: 'search', description: 'Search messages and activity', run: () => onNavigate('search') },
  ] : []
  const commands: CommandDef[] = [
    { name: 'all', description: 'Mention everyone in the channel', run: () => insertText('@all ') },
    ...scopeCommands,
    ...navCommands,
    { name: 'clear', description: 'Clear the draft', run: () => setContent('') },
  ]

  const commandMatches = token?.kind === 'command'
    ? commands.filter((command) => command.name.startsWith(token.query))
    : []

  const popupItems = token?.kind === 'mention' ? mentionMatches : commandMatches
  const popupOpen = token !== null && popupItems.length > 0

  function insertText(text: string) {
    if (!token) return
    const caret = textareaRef.current?.selectionStart ?? content.length
    const next = `${content.slice(0, token.start)}${text}${content.slice(caret)}`
    setContent(next)
    setToken(null)
    setActiveIndex(0)
    const position = token.start + text.length
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(position, position))
  }

  function choose(index: number) {
    if (!token) return
    if (token.kind === 'mention') {
      const profile = mentionMatches[index]
      if (profile) insertText(`@${profile.name === 'all' ? 'all' : mentionHandle(presentation, profile.name)} `)
      return
    }
    const command = commandMatches[index]
    if (!command) return
    const caret = textareaRef.current?.selectionStart ?? content.length
    const remainder = content.slice(caret)
    setContent(remainder.trimStart())
    setToken(null)
    setActiveIndex(0)
    command.run()
    textareaRef.current?.focus()
  }

  const projectReady = project.mode !== 'project' || Boolean(project.profile && project.projectId && project.cwd)

  function resolvedMentions(): string[] {
    // Token-scan with the same boundaries the popup and highlighter accept
    // ("(@Atlas" or "@Atlas," count). No RegExp is built from names — a
    // profile called "team(" must not be able to throw here. Members answer
    // to their profile id and their display-name handle; both resolve to the
    // profile id the backend routes on.
    const tokens = new Set(
      [...content.matchAll(/(?:^|[\s([{])@([\w-]+)/g)].map((match) => match[1].toLowerCase()),
    )
    const named = profiles.filter((profile) => (
      tokens.has(profile.name.toLowerCase())
      || tokens.has(mentionHandle(presentation, profile.name).toLowerCase())
    )).map((profile) => profile.name)
    const all = tokens.has('all') ? profiles.map((profile) => profile.name) : []
    return [...new Set([...named, ...all])]
  }

  async function send(attempt?: PendingAttempt) {
    // sendingRef guards synchronously: Enter key-repeat fires faster than
    // React commits `sending`, and each call would mint a fresh idempotency
    // key the server cannot dedupe.
    if (sendingRef.current || !content.trim() || !projectReady) return
    sendingRef.current = true
    setSending(true)
    setError('')
    const pending = attempt || {
      body: {
        content: content.trim(),
        idempotencyKey: crypto.randomUUID(),
        mentions: resolvedMentions(),
        rootMessageId,
        project: fixedProject || project,
        attachments: [],
      },
      message: {
        id: '',
        channelId,
        rootMessageId,
        authorType: 'user' as const,
        authorProfileId: null,
        content: content.trim(),
        mentions: resolvedMentions(),
        project: fixedProject || project,
        modelLabel: null,
        createdAt: Date.now(),
      },
    }
    if (!pending.message.id) pending.message.id = `local:${pending.body.idempotencyKey}`
    onPending?.(pending.message)
    try {
      const receipt = await api.createMessage(channelId, pending.body)
      onSent(receipt, pending.message.id)
      setContent('')
      setFailedAttempt(null)
      if (!rootMessageId) setProject({ mode: 'inherit' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Message could not be sent')
      setFailedAttempt(pending)
      onFailed?.(pending.message.id)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void send()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((current) => (current + 1) % popupItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((current) => current <= 0 ? popupItems.length - 1 : current - 1)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(activeIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setToken(null)
        setActiveIndex(0)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  // Backdrop highlighting for @mentions the crew will actually receive.
  const highlighted = useMemo((): ReactNode[] => {
    const known = new Set([
      ...profiles.map((profile) => profile.name.toLowerCase()),
      ...profiles.map((profile) => mentionHandle(presentation, profile.name).toLowerCase()),
      'all',
    ])
    return content.split(/(@[\w-]+)/g).map((part, index) => (
      index % 2 === 1 && known.has(part.slice(1).toLowerCase())
        ? <mark className="rounded-sm bg-(--ui-accent)/15 text-transparent" key={index}>{part}</mark>
        : part
    ))
  }, [content, profiles, presentation])

  const fieldId = `crew-message-${rootMessageId || channelId}`

  return (
    <form aria-label={rootMessageId ? 'Thread message' : 'Channel message'} className="@container relative grid gap-2 bg-background p-3 pt-1" onSubmit={submit}>
      <div className="rounded-2xl border border-(--ui-stroke-secondary) bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-(--ui-accent) focus-within:shadow-md">
        <label className="sr-only" htmlFor={fieldId}>Message</label>
        <div className="relative">
          {popupOpen ? (
            <div aria-label={token?.kind === 'mention' ? 'Mention suggestions' : 'Command suggestions'} className="absolute bottom-full left-3 z-10 mb-2 grid max-h-72 min-w-64 overflow-auto rounded-xl border border-(--ui-stroke-secondary) bg-background p-1 shadow-lg" role="listbox">
              {token?.kind === 'mention'
                ? mentionMatches.map((profile, index) => {
                  const handle = profile.name === 'all' ? 'all' : mentionHandle(presentation, profile.name)
                  return (
                    <button aria-label={`@${handle}`} aria-selected={index === activeIndex} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${index === activeIndex ? 'bg-(--ui-accent)/10' : 'hover:bg-(--ui-surface-secondary)'}`} key={profile.name} onClick={() => choose(index)} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} role="option" type="button">
                      <MemberAvatar profileId={profile.name} size="sm" />
                      <span className="min-w-0">
                        <span className={`block truncate ${index === activeIndex ? 'font-medium text-(--ui-accent)' : 'font-medium'}`}>@{handle}</span>
                        <span className="block truncate text-[11px] text-(--ui-text-tertiary)">{profile.name === 'all' ? profile.description : presentedName(presentation, profile.name)}{profile.name !== 'all' && profile.description ? ` · ${profile.description}` : ''}</span>
                      </span>
                    </button>
                  )
                })
                : commandMatches.map((command, index) => (
                  <button aria-label={`/${command.name}`} aria-selected={index === activeIndex} className={`flex items-baseline gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${index === activeIndex ? 'bg-(--ui-accent)/10' : 'hover:bg-(--ui-surface-secondary)'}`} key={command.name} onClick={() => choose(index)} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} role="option" type="button">
                    <code className="shrink-0 rounded bg-(--ui-surface-secondary) px-1.5 py-0.5 text-[12px] font-semibold text-foreground">/{command.name}</code>
                    <span className="min-w-0 truncate text-[11px] text-(--ui-text-tertiary)">{command.description}</span>
                  </button>
                ))}
            </div>
          ) : null}
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 max-h-48 overflow-hidden whitespace-pre-wrap text-transparent ${FIELD_TYPOGRAPHY}`} ref={overlayRef}>{highlighted}{'​'}</div>
          <textarea
            className={`relative max-h-48 min-h-12 w-full resize-none overflow-y-auto bg-transparent outline-none ${FIELD_TYPOGRAPHY}`}
            id={fieldId}
            onChange={(event) => { setContent(event.target.value); syncToken(event.target.value) }}
            onClick={() => syncToken(content)}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncToken(content) }}
            onScroll={(event) => { if (overlayRef.current) overlayRef.current.scrollTop = event.currentTarget.scrollTop }}
            placeholder="Message the channel…  ( @ mentions · / commands )"
            ref={textareaRef}
            rows={1}
            value={content}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
          {error ? <div className="flex min-w-0 items-center gap-2 pl-1 text-xs text-red-500"><p className="truncate" role="alert">{error}</p>{failedAttempt ? <button aria-label="Retry message" className="shrink-0 font-medium text-foreground hover:underline" disabled={sending} onClick={() => void send(failedAttempt)} type="button">Retry</button> : null}</div> : <span aria-hidden="true" className="hidden pl-1 text-[11px] text-(--ui-text-tertiary) @xl:inline"><kbd>@</kbd> mention · <kbd>/</kbd> commands · <kbd>Enter</kbd> to send</span>}
          <div className="ml-auto flex items-center gap-2">
            {fixedProject
              ? (projectChipLabel(fixedProject) ? <span className="max-w-40 truncate rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary)" title="Thread project scope">{projectChipLabel(fixedProject)}</span> : null)
              : <ProjectMenu api={api} onChange={setProject} profiles={profiles} value={project} />}
            <button className="rounded-full bg-(--ui-accent) px-4 py-1.5 text-sm font-medium text-white shadow-sm transition-opacity disabled:opacity-40" disabled={sending || !content.trim() || !projectReady} type="submit">{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      </div>
    </form>
  )
}
