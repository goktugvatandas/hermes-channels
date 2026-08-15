import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ContextMenuTrigger,
  host,
} from '@hermes/plugin-sdk'
import { forwardRef, useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react'

import type { CrewApi } from '../api'
import { requestBotCreate } from '../bot-create-signal'
import { mirrorAvatarToBotMode, openAgentChat, pullProfileAvatar, readBotModeMeta } from '../bot-mode-bridge'
import { ChannelNavigationController, channelPath } from '../channel-navigation'
import type { ChannelSections, CrewChannel, CrewMember } from '../types'
import { BotAvatar } from './shape-avatar'
import { ThemedSelect } from './themed-select'

export function PaneUnreadDot({ controller }: { controller: ChannelNavigationController }) {
  const [, setTick] = useState(0)
  useEffect(() => controller.subscribe(() => setTick((value) => value + 1)), [controller])
  if (controller.totalUnread() === 0) return null
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        marginRight: 5,
        borderRadius: '50%',
        background: 'var(--ui-accent, #3EE6C1)',
        boxShadow: '0 0 6px var(--ui-accent, #3EE6C1)',
      }}
    />
  )
}

const BOT_MANAGEMENT_PATH = '/channels/bot-management'
const SETTINGS_PATH = '/channels/settings'
const EMPTY_SECTIONS: ChannelSections = { sections: [], assignments: {} }
/** Matches the channel list's reconcile cadence in ChannelNavigationController. */
const SECTIONS_REFRESH_MS = 10_000

function sectionsEqual(a: ChannelSections, b: ChannelSections): boolean {
  if (a === b) return true
  if (a.sections.length !== b.sections.length) return false
  for (let i = 0; i < a.sections.length; i += 1) {
    if (a.sections[i].id !== b.sections[i].id || a.sections[i].name !== b.sections[i].name) return false
  }
  const aKeys = Object.keys(a.assignments)
  const bKeys = Object.keys(b.assignments)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a.assignments[key] === b.assignments[key])
}
const COLLAPSED_KEY = 'hermes-channels.pane-collapsed-v1'

interface CrewPaneProps {
  api: Pick<
    CrewApi,
    'listMembers' | 'updateMember' | 'getChannelSections' | 'putChannelSections' | 'createChannel' | 'patchChannel' | 'listProfiles'
  >
  controller: ChannelNavigationController
}

interface MenuItem {
  label: string
  danger?: boolean
  onSelect(): void
}

interface DialogState {
  title: string
  placeholder: string
  initial?: string
  submitLabel: string
  onSubmit(value: string): void
}

interface CreateChannelDialogProps {
  open: boolean
  bots: CrewMember[]
  onClose(): void
  onCreate(body: { name: string; defaultResponderProfile: string | null; members: Array<{ profileId: string; activationPolicy: string }> }): void
}

/** Channel creation is deliberate: pick the name, pick WHICH bots join
 *  (none pre-selected — members can always be added later from the channel's
 *  details rail), and optionally a default responder for untagged messages. */
function CreateChannelDialog({ open, bots, onClose, onCreate }: CreateChannelDialogProps) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [responder, setResponder] = useState('')
  const [botFilter, setBotFilter] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setSelected(new Set())
    setResponder('')
    setBotFilter('')
  }, [open])

  function toggle(profileId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(profileId)) next.delete(profileId)
      else next.add(profileId)
      return next
    })
    if (responder === profileId && selected.has(profileId)) setResponder('')
  }

  const selectedList = bots.filter((bot) => selected.has(bot.profileId))
  const query = botFilter.trim().toLowerCase()
  // Selected bots surface first so a long filtered roster never hides who is
  // already in — the checklist stays legible at 50+ bots.
  const visibleBots = bots
    .filter((bot) => {
      if (!query) return true
      const label = `${bot.displayName || ''} ${bot.profileId}`.toLowerCase()
      return label.includes(query) || selected.has(bot.profileId)
    })
    .sort((left, right) =>
      Number(selected.has(right.profileId)) - Number(selected.has(left.profileId)))

  return (
    <Dialog onOpenChange={(isOpen) => { if (!isOpen) onClose() }} open={open}>
      <DialogContent className="max-w-sm">
        <div className="hermes-channels-desktop">
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
          </DialogHeader>
          <form
            className="mt-3 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = name.trim().replace(/^#/, '')
              if (!trimmed) return
              onCreate({
                name: trimmed,
                defaultResponderProfile: responder || null,
                members: selectedList.map((bot) => ({
                  profileId: bot.profileId,
                  activationPolicy: 'mentioned',
                })),
              })
            }}
          >
            <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">
              Name
              <input
                autoFocus
                className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm font-normal text-foreground"
                onChange={(event) => setName(event.target.value)}
                placeholder="research"
                value={name}
              />
            </label>
            <fieldset className="grid gap-1">
              <legend className="flex w-full items-baseline justify-between text-xs font-medium text-(--ui-text-secondary)">
                <span>Bots</span>
                <span className="font-normal text-(--ui-text-tertiary)">{selected.size} selected</span>
              </legend>
              <p className="text-[11px] text-(--ui-text-tertiary)">Pick who joins now — you can add or remove members any time from the channel details.</p>
              {bots.length > 6 ? (
                <input
                  aria-label="Filter bots"
                  className="mt-1 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1 text-xs"
                  onChange={(event) => setBotFilter(event.target.value)}
                  placeholder="Filter bots…"
                  value={botFilter}
                />
              ) : null}
              <div className="mt-1 grid max-h-52 gap-0.5 overflow-y-auto">
                {visibleBots.length === 0 ? (
                  <p className="px-1.5 py-1 text-[11px] text-(--ui-text-tertiary)">No bots match “{botFilter}”.</p>
                ) : null}
                {visibleBots.map((bot) => {
                  const botName = bot.displayName || bot.profileId
                  return (
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-(--ui-surface-secondary)" key={bot.profileId}>
                      <input
                        checked={selected.has(bot.profileId)}
                        className="accent-(--ui-accent)"
                        onChange={() => toggle(bot.profileId)}
                        type="checkbox"
                      />
                      <BotAvatar avatar={bot.avatar} color={bot.color} name={botName} profileId={bot.profileId} size="sm" />
                      <span className="min-w-0 truncate">{botName}</span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">
              Default responder
              <ThemedSelect
                ariaLabel="Default responder"
                className="h-8 w-full rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1.5 text-sm font-normal text-foreground"
                onChange={(next) => setResponder(next === '__none__' ? '' : next)}
                options={[
                  { value: '__none__', label: 'None — bots answer only when mentioned' },
                  ...selectedList.map((bot) => ({
                    value: bot.profileId,
                    label: bot.displayName || bot.profileId,
                  })),
                ]}
                value={responder || '__none__'}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm hover:bg-(--ui-surface-secondary)" onClick={onClose} type="button">Cancel</button>
              <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={!name.trim()} type="submit">Create</button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Host-native right-click menu (Radix portals through the host, so it
 *  positions correctly despite the pane tree's CSS transforms). */
function RowContextMenu({ items, children }: { items: MenuItem[]; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {items.map((item) => (
          <ContextMenuItem
            key={item.label}
            onSelect={() => item.onSelect()}
            style={item.danger ? { color: '#ef4444' } : undefined}
          >
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} unread`}
      className="ml-auto inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-(--ui-accent) px-1.5 py-0.5 text-[10px] font-bold leading-none text-white ring-2 ring-(--ui-accent)/25"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function sectionSlug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'section'
  let slug = base
  let counter = 2
  while (taken.has(slug)) slug = `${base}-${counter++}`
  return slug
}

const SectionHeading = forwardRef<HTMLDivElement, {
  label: string
  action?: { title: string; onClick(): void }
  collapsed?: boolean
  onToggle?(): void
  badge?: number
} & HTMLAttributes<HTMLDivElement>>(function SectionHeading(
  { label, action, collapsed, onToggle, badge, className, ...props },
  ref,
) {
  return (
    <div {...props} className={`mt-4 flex items-center justify-between px-2 ${className ?? ''}`} ref={ref}>
      <button
        aria-expanded={onToggle ? !collapsed : undefined}
        className="flex min-w-0 items-center gap-1 rounded text-left transition-colors hover:text-(--ui-text-secondary)"
        onClick={onToggle}
        type="button"
      >
        {onToggle ? (
          <span
            aria-hidden="true"
            className="codicon codicon-chevron-down text-(--ui-text-tertiary) transition-transform"
            style={{ fontSize: 11, width: 11, height: 11, transform: collapsed ? 'rotate(-90deg)' : undefined }}
          />
        ) : null}
        <h3 className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">{label}</h3>
        {collapsed && badge ? <UnreadBadge count={badge} /> : null}
      </button>
      {action ? (
        <button
          aria-label={action.title}
          className="rounded px-1 text-sm leading-none text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-secondary)"
          onClick={action.onClick}
          title={action.title}
          type="button"
        >
          +
        </button>
      ) : null}
    </div>
  )
})

/**
 * The CHANNELS tab: channels grouped into user-defined sections (drag rows
 * between groups), the bot roster, and a Settings footer. Right-click menus
 * carry the management verbs so the pane itself stays quiet.
 */
export function CrewPane({ api, controller }: CrewPaneProps) {
  const [, setTick] = useState(0)
  const [members, setMembers] = useState<CrewMember[]>([])
  const [sections, setSections] = useState<ChannelSections>(EMPTY_SECTIONS)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [botSearch, setBotSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
    } catch {
      return new Set()
    }
  })

  function toggleCollapsed(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Collapse state is a nicety; never break the pane over storage.
      }
      return next
    })
  }

  function groupUnread(list: CrewChannel[]): number {
    return list.reduce((sum, channel) => sum + controller.unreadCount(channel.id), 0)
  }
  const [dialogValue, setDialogValue] = useState('')
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const avatarPullsInFlight = useRef(new Set<string>())

  useEffect(() => controller.subscribe(() => setTick((value) => value + 1)), [controller])

  const loadMembers = useCallback(() => {
    // Profiles are the roster's source of truth — a bot created seconds ago
    // has no presentation row yet, so merge instead of relying on /members.
    void Promise.all([api.listProfiles(), api.listMembers()])
      .then(async ([profiles, presented]) => {
        const byId = new Map(presented.map((member) => [member.profileId, member]))
        const roster = profiles
          .map((profile) => byId.get(profile.name) ?? {
            profileId: profile.name,
            displayName: profile.name,
            role: '',
            avatar: null,
            color: null,
            defaultProject: null,
            archived: false,
          })
          .filter((member) => !member.archived)
        setMembers(roster)
        // The profile asset store (shared with Bot Mode) may hold an avatar
        // this workspace has never seen. Retry on every refresh — the image
        // may appear at any time — but never overlap pulls per bot, and run
        // the independent per-bot syncs concurrently.
        const syncAppearance = async (member: CrewMember) => {
          if (member.avatar || avatarPullsInFlight.current.has(member.profileId)) return
          avatarPullsInFlight.current.add(member.profileId)
          try {
            let pulled = await pullProfileAvatar(member.profileId)
            if (!pulled) {
              // Bot Mode may hold the image only locally (older gateways, or
              // a failed asset write) — adopt it and heal the asset store.
              const meta = readBotModeMeta(member.profileId)
              if (meta.image) {
                pulled = meta.image
                mirrorAvatarToBotMode(member.profileId, meta.image)
              } else if (meta.color && !member.color) {
                // Shape avatars can't be exported; sharing the hue keeps the
                // two rosters visually in sync.
                setMembers((current) => current.map((item) => (
                  item.profileId === member.profileId ? { ...item, color: meta.color } : item
                )))
                try {
                  await api.updateMember(member.profileId, { color: meta.color })
                } catch {
                  // Cosmetic; retried next refresh.
                }
                return
              } else {
                return
              }
            }
            setMembers((current) => current.map((item) => (
              item.profileId === member.profileId ? { ...item, avatar: pulled } : item
            )))
            try {
              await api.updateMember(member.profileId, { avatar: pulled })
            } catch {
              // Shown locally regardless; persistence retries next refresh.
            }
          } finally {
            avatarPullsInFlight.current.delete(member.profileId)
          }
        }
        await Promise.allSettled(roster.map(syncAppearance))
      })
      .catch(() => {
        // The roster section stays empty until a later refresh succeeds.
      })
  }, [api])

  // Sections are a workspace-wide document that scripts, bots and other
  // windows write behind this pane's back, so it is re-read on the same
  // cadence channels reconcile. Two guards keep the local copy honest: a
  // fetch that started before a save must not overwrite that save's result
  // (sequence check), and a poll must never land while a PUT is in flight
  // (the pending optimistic state is newer than anything the server holds).
  const sectionsFetchSeq = useRef(0)
  const sectionsSaving = useRef(0)
  const loadSections = useCallback(() => {
    const seq = ++sectionsFetchSeq.current
    void api.getChannelSections()
      .then((next) => {
        if (seq !== sectionsFetchSeq.current || sectionsSaving.current > 0) return
        setSections((current) => (sectionsEqual(current, next) ? current : next))
      })
      .catch(() => {
        // Grouping is progressive enhancement; a flat list still works.
      })
  }, [api])

  useEffect(() => {
    loadMembers()
    const memberTimer = setInterval(loadMembers, 60_000)
    const sectionTimer = setInterval(loadSections, SECTIONS_REFRESH_MS)
    const onFocus = () => { loadMembers(); loadSections() }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(memberTimer)
      clearInterval(sectionTimer)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadMembers, loadSections])

  const channels = controller.channelList()
  // Initial load, and again whenever the channel set changes: programmatic
  // setups create channels and their sections together, so the grouping is
  // re-read the moment new channels appear instead of waiting for the poll.
  const channelKey = channels.map((channel) => channel.id).sort().join('\u0000')
  useEffect(() => {
    loadSections()
  }, [channelKey, loadSections])
  const viewed = controller.viewedChannel()
  // The subscribe/setTick effect re-renders on every controller change, so
  // reading the live total is both simpler and never stale.
  const totalUnread = controller.totalUnread()

  const knownSections = new Set(sections.sections.map((section) => section.id))
  const grouped = new Map<string, CrewChannel[]>()
  const unassigned: CrewChannel[] = []
  for (const channel of channels) {
    const assigned = sections.assignments[channel.id]
    if (assigned && knownSections.has(assigned)) {
      grouped.set(assigned, [...(grouped.get(assigned) ?? []), channel])
    } else {
      unassigned.push(channel)
    }
  }

  function openDialog(state: DialogState) {
    setDialogValue(state.initial ?? '')
    setDialog(state)
  }

  function saveSections(next: ChannelSections) {
    setSections(next)
    sectionsSaving.current += 1
    // Invalidate any fetch already in flight: its response predates this write.
    sectionsFetchSeq.current += 1
    void api.putChannelSections(next)
      .then((saved) => {
        sectionsSaving.current -= 1
        setSections(saved)
      })
      .catch(() => {
        sectionsSaving.current -= 1
        loadSections()
      })
  }

  function assignChannel(channelId: string, sectionId: string | null) {
    const assignments = { ...sections.assignments }
    if (sectionId) assignments[channelId] = sectionId
    else delete assignments[channelId]
    saveSections({ ...sections, assignments })
  }

  function addSection(assignChannelId?: string) {
    openDialog({
      title: 'New section',
      placeholder: 'Section name (e.g. Project X)',
      submitLabel: 'Create',
      onSubmit: (value) => {
        // One atomic document write: creating and assigning in two PUTs
        // raced each other (the second used a stale closure).
        const id = sectionSlug(value, knownSections)
        saveSections({
          sections: [...sections.sections, { id, name: value }],
          assignments: assignChannelId
            ? { ...sections.assignments, [assignChannelId]: id }
            : sections.assignments,
        })
      },
    })
  }

  function createChannel() {
    setCreateOpen(true)
  }

  function channelMenuItems(channel: CrewChannel): MenuItem[] {
    const moves: MenuItem[] = sections.sections
      .filter((section) => sections.assignments[channel.id] !== section.id)
      .map((section) => ({
        label: `Move to ${section.name}`,
        onSelect: () => assignChannel(channel.id, section.id),
      }))
    if (sections.assignments[channel.id]) {
      moves.push({ label: 'Move to Channels', onSelect: () => assignChannel(channel.id, null) })
    }
    return [
      { label: 'Open', onSelect: () => host.navigate(channelPath(channel.id)) },
      ...(controller.unreadCount(channel.id) > 0
        ? [{ label: 'Mark as read', onSelect: () => controller.markRead(channel.id) }]
        : []),
      {
        label: 'Rename…',
        onSelect: () => openDialog({
          title: `Rename #${channel.name}`,
          placeholder: 'Channel name',
          initial: channel.name,
          submitLabel: 'Rename',
          onSubmit: (value) => {
            void api.patchChannel(channel.id, { name: value.replace(/^#/, '') })
              .then((updated) => controller.upsertChannel(updated))
              .catch(() => host.notify?.({ kind: 'error', message: 'Rename failed' }))
          },
        }),
      },
      ...moves,
      { label: 'New section…', onSelect: () => addSection(channel.id) },
    ]
  }

  function sectionMenuItems(sectionId: string, name: string): MenuItem[] {
    return [
      { label: 'New channel…', onSelect: createChannel },
      {
        label: 'Rename section…',
        onSelect: () => openDialog({
          title: `Rename ${name}`,
          placeholder: 'Section name',
          initial: name,
          submitLabel: 'Rename',
          onSubmit: (value) => saveSections({
            ...sections,
            sections: sections.sections.map((section) => (
              section.id === sectionId ? { ...section, name: value } : section
            )),
          }),
        }),
      },
      {
        label: 'Delete section',
        danger: true,
        onSelect: () => {
          const assignments = Object.fromEntries(
            Object.entries(sections.assignments).filter(([, target]) => target !== sectionId),
          )
          saveSections({
            sections: sections.sections.filter((section) => section.id !== sectionId),
            assignments,
          })
        },
      },
    ]
  }

  function botMenuItems(member: CrewMember): MenuItem[] {
    const name = member.displayName || member.profileId
    return [
      { label: `Chat with ${name}`, onSelect: () => { void openAgentChat(member.profileId) } },
      { label: 'Edit in Bot Management', onSelect: () => host.navigate(BOT_MANAGEMENT_PATH) },
    ]
  }

  function dropProps(sectionId: string | null) {
    const key = sectionId ?? '__root__'
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('application/x-channel-id')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(key)
      },
      onDragLeave: () => setDropTarget((current) => (current === key ? null : current)),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        setDropTarget(null)
        const channelId = event.dataTransfer.getData('application/x-channel-id')
        if (channelId) assignChannel(channelId, sectionId)
      },
    }
  }

  function renderChannelRow(channel: CrewChannel) {
    const unread = controller.unreadCount(channel.id)
    return (
      <RowContextMenu items={channelMenuItems(channel)} key={channel.id}>
        <button
          aria-current={viewed === channel.id ? 'page' : undefined}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${viewed === channel.id ? 'bg-(--ui-accent)/12 text-foreground' : 'text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary) hover:text-foreground'}`}
          draggable
          onClick={() => host.navigate(channelPath(channel.id))}
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-channel-id', channel.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
          type="button"
        >
          <span aria-hidden="true" className="codicon codicon-symbol-numeric shrink-0 opacity-70" style={{ width: 14, height: 14 }} />
          <span className={`min-w-0 truncate ${unread > 0 ? 'font-semibold text-foreground' : ''}`}>{channel.name}</span>
          {unread > 0 ? (
            <span aria-hidden="true" className="ml-1 size-1.5 shrink-0 animate-pulse rounded-full bg-(--ui-accent)" />
          ) : null}
          {unread > 0 ? <UnreadBadge count={unread} /> : null}
        </button>
      </RowContextMenu>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <div className="flex items-center justify-between px-2 pt-1">
        <button
          className="flex items-center gap-2 rounded-lg text-sm font-semibold text-foreground transition-opacity hover:opacity-80"
          onClick={() => host.navigate('/channels')}
          type="button"
        >
          <span aria-hidden="true" className="codicon codicon-organization" style={{ width: 15, height: 15 }} />
          Hermes Channels
        </button>
        {totalUnread > 0 ? <UnreadBadge count={totalUnread} /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={`rounded-lg ${dropTarget === '__root__' ? 'bg-(--ui-accent)/8 outline outline-1 outline-(--ui-accent)/40' : ''}`}
          {...dropProps(null)}
        >
          <RowContextMenu items={[
            { label: 'New channel…', onSelect: createChannel },
            { label: 'New section…', onSelect: () => addSection() },
          ]}>
            <SectionHeading
              action={{ title: 'New channel', onClick: createChannel }}
              badge={groupUnread(unassigned)}
              collapsed={collapsed.has('__root__')}
              label="Channels"
              onToggle={() => toggleCollapsed('__root__')}
            />
          </RowContextMenu>
          {collapsed.has('__root__') ? null : (
            <div className="mt-1 grid gap-0.5">
              {channels.length === 0 ? (
                <p className="px-2 py-1 text-xs text-(--ui-text-tertiary)">No channels yet — right-click or hit + to create one.</p>
              ) : unassigned.map(renderChannelRow)}
            </div>
          )}
        </div>

        {sections.sections.map((section) => (
          <div
            className={`rounded-lg ${dropTarget === section.id ? 'bg-(--ui-accent)/8 outline outline-1 outline-(--ui-accent)/40' : ''}`}
            data-section={section.id}
            key={section.id}
            {...dropProps(section.id)}
          >
            <RowContextMenu items={sectionMenuItems(section.id, section.name)}>
              <SectionHeading
                badge={groupUnread(grouped.get(section.id) ?? [])}
                collapsed={collapsed.has(section.id)}
                label={section.name}
                onToggle={() => toggleCollapsed(section.id)}
              />
            </RowContextMenu>
            {collapsed.has(section.id) ? null : (
              <div className="mt-1 grid gap-0.5">
                {(grouped.get(section.id) ?? []).length === 0 ? (
                  <p className="px-2 py-1 text-xs text-(--ui-text-tertiary)">Drop channels here.</p>
                ) : (grouped.get(section.id) ?? []).map(renderChannelRow)}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-(--ui-stroke-secondary)">
        <RowContextMenu items={[
          { label: 'New bot…', onSelect: () => { requestBotCreate(); host.navigate(BOT_MANAGEMENT_PATH) } },
          { label: 'Open Bot Management', onSelect: () => host.navigate(BOT_MANAGEMENT_PATH) },
        ]}>
          <SectionHeading
            action={{ title: 'New bot', onClick: () => { requestBotCreate(); host.navigate(BOT_MANAGEMENT_PATH) } }}
            collapsed={collapsed.has('__bots__')}
            label="Bots"
            onToggle={() => toggleCollapsed('__bots__')}
          />
        </RowContextMenu>
        {!collapsed.has('__bots__') && members.length > 8 ? (
          <div className="mt-1 px-2">
            <input
              aria-label="Search bots"
              className="w-full rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1 text-xs"
              onChange={(event) => setBotSearch(event.target.value)}
              placeholder="Search bots…"
              value={botSearch}
            />
          </div>
        ) : null}
        <div className="mb-2 mt-1 grid max-h-72 gap-0.5 overflow-y-auto">
          {(collapsed.has('__bots__') ? [] : members)
            .filter((member) => {
              const query = botSearch.trim().toLowerCase()
              if (!query) return true
              return `${member.displayName || ''} ${member.profileId}`.toLowerCase().includes(query)
            })
            .map((member) => {
            const name = member.displayName || member.profileId
            return (
              <RowContextMenu items={botMenuItems(member)} key={member.profileId}>
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-(--ui-text-secondary) transition-colors hover:bg-(--ui-surface-secondary) hover:text-foreground"
                  onClick={() => { void openAgentChat(member.profileId) }}
                  title={`Chat with ${name}`}
                  type="button"
                >
                  <BotAvatar avatar={member.avatar} color={member.color} name={name} profileId={member.profileId} size="sm" />
                  <span className="min-w-0 truncate">{name}</span>
                </button>
              </RowContextMenu>
            )
          })}
        </div>
      </div>

      <div className="border-t border-(--ui-stroke-secondary) pt-1">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-(--ui-text-secondary) transition-colors hover:bg-(--ui-surface-secondary) hover:text-foreground"
          onClick={() => host.navigate(SETTINGS_PATH)}
          type="button"
        >
          <span aria-hidden="true" className="codicon codicon-settings-gear shrink-0 opacity-70" style={{ width: 14, height: 14 }} />
          Settings
        </button>
      </div>

      <CreateChannelDialog
        bots={members}
        onClose={() => setCreateOpen(false)}
        onCreate={(body) => {
          setCreateOpen(false)
          void api.createChannel(body)
            .then((channel) => {
              controller.upsertChannel(channel)
              host.navigate(channelPath(channel.id))
            })
            .catch(() => host.notify?.({ kind: 'error', message: 'Channel could not be created' }))
        }}
        open={createOpen}
      />

      <Dialog onOpenChange={(open) => { if (!open) setDialog(null) }} open={dialog !== null}>
        <DialogContent className="max-w-xs">
          <div className="hermes-channels-desktop">
            <DialogHeader>
              <DialogTitle>{dialog?.title}</DialogTitle>
            </DialogHeader>
            <form
              className="mt-3 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                const value = dialogValue.trim()
                if (!value || !dialog) return
                const submit = dialog.onSubmit
                setDialog(null)
                submit(value)
              }}
            >
              <input
                autoFocus
                className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2.5 py-1.5 text-sm"
                onChange={(event) => setDialogValue(event.target.value)}
                placeholder={dialog?.placeholder}
                value={dialogValue}
              />
              <div className="flex justify-end gap-2">
                <button className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm hover:bg-(--ui-surface-secondary)" onClick={() => setDialog(null)} type="button">Cancel</button>
                <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={!dialogValue.trim()} type="submit">{dialog?.submitLabel}</button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
