import { useEffect, useMemo, useState } from 'react'

import type { CrewApi } from '../api'
import { summarizeTurns, turnStateLabel } from '../conversation-model'
import { MemberAvatar, UserAvatar, presentedName, usePresentation } from '../presentation'
import type { CrewChannel, EventFrame, HermesProfile } from '../types'

interface HomeViewProps {
  api: CrewApi
  channels: CrewChannel[]
  profiles: HermesProfile[]
  events: EventFrame[]
  onOpenChannel(channelId: string): void
  onOpenWorkshop(): void
  onOpenProfile(): void
}

export function HomeView({ api, channels, profiles, events, onOpenChannel, onOpenWorkshop, onOpenProfile }: HomeViewProps) {
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({})
  const [stopping, setStopping] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const presentation = usePresentation()
  const displayName = (profileId: string) => presentedName(presentation, profileId)

  useEffect(() => {
    let current = true
    void Promise.all(channels.map(async (channel) => {
      try {
        const members = await api.listChannelMembers(channel.id)
        return [channel.id, members.length] as const
      } catch {
        return [channel.id, 0] as const
      }
    })).then((entries) => { if (current) setMemberCounts(Object.fromEntries(entries)) })
    return () => { current = false }
  }, [api, channels])

  const turns = useMemo(() => summarizeTurns(events), [events])
  const running = turns.filter((turn) => !turn.terminal)
  const recent = turns.filter((turn) => turn.terminal).slice(-4).reverse()
  const online = profiles.filter((profile) => profile.gatewayRunning).length
  const channelName = (channelId: string) => {
    const channel = channels.find((item) => item.id === channelId)
    return channel ? `#${channel.name}` : null
  }

  async function stop(turnId: string, profile: string) {
    setStopping((current) => [...current, turnId])
    try {
      await api.cancelTurn(turnId)
      setAnnouncement(`Stop requested for ${profile}`)
    } catch {
      setStopping((current) => current.filter((id) => id !== turnId))
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto grid w-full max-w-4xl content-start gap-8 px-6 py-8">
        <section aria-label="Workspace status" className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex -space-x-3">
              {profiles.slice(0, 5).map((profile) => (
                <span className="rounded-full ring-2 ring-(--color-background)" key={profile.name}><MemberAvatar profileId={profile.name} size="lg" /></span>
              ))}
            </div>
            <div>
              <h2 className="text-lg font-semibold">Your bots</h2>
              <p className="text-sm text-(--ui-text-secondary)">
                {profiles.length} {profiles.length === 1 ? 'bot' : 'bots'} · {online} online · {channels.length} {channels.length === 1 ? 'channel' : 'channels'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button aria-label="Edit your profile" className="flex items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) py-1 pl-1 pr-3 text-sm font-medium transition-colors hover:bg-(--ui-surface-secondary)" onClick={onOpenProfile} title="Edit your profile" type="button"><UserAvatar size="sm" /> Profile</button>
            <button className="rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white" onClick={onOpenWorkshop} type="button">Open Bot Management</button>
          </div>
        </section>

        <section aria-label="Live activity" className="grid gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Now running</h3>
          {running.length ? (
            <ul className="grid gap-2">
              {running.map((turn) => (
                <li className="flex items-center justify-between gap-3 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3" key={turn.turnId}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="relative flex size-2.5 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-(--ui-accent) opacity-60 motion-reduce:animate-none" /><span className="relative inline-flex size-2.5 rounded-full bg-(--ui-accent)" /></span>
                    <MemberAvatar profileId={turn.profileId} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{displayName(turn.profileId)}</p>
                      <p className="truncate text-xs text-(--ui-text-secondary)">{turnStateLabel(turn.state)}{channelName(turn.events[0]?.channelId || '') ? ` · ${channelName(turn.events[0].channelId)}` : ''}</p>
                    </div>
                  </div>
                  <button aria-label={`Stop ${turn.profileId}`} className="shrink-0 rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary) disabled:opacity-50" disabled={stopping.includes(turn.turnId)} onClick={() => void stop(turn.turnId, turn.profileId)} type="button">Stop</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-(--ui-stroke-secondary) px-4 py-6 text-center text-sm text-(--ui-text-tertiary)">All quiet. Open a channel and mention an agent to get things moving.</p>
          )}
        </section>

        <section aria-label="Channel workspaces" className="grid gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Workspaces</h3>
          <ul className="grid gap-3 @3xl:grid-cols-2">
            {channels.map((channel) => {
              const responder = channel.defaultResponderProfile
              const project = channel.defaultProject?.mode === 'project'
                ? channel.defaultProject.label || channel.defaultProject.projectId
                : 'Global'
              return (
                <li key={channel.id}>
                  <button className="grid w-full gap-2 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3 text-left transition-colors hover:border-(--ui-accent) hover:bg-(--ui-surface-secondary)" onClick={() => onOpenChannel(channel.id)} type="button">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold"><span className="text-(--ui-text-tertiary)">#</span>{channel.name}</span>
                      <span className="shrink-0 rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary)">{project}</span>
                    </span>
                    <span className="truncate text-xs text-(--ui-text-secondary)">{channel.topic || channel.purpose || 'Shared channel'}</span>
                    <span className="flex items-center gap-2 text-[11px] text-(--ui-text-tertiary)">
                      {responder ? <span className="flex items-center gap-1"><MemberAvatar profileId={responder} size="sm" /> {displayName(responder)} answers by default</span> : <span>Mention-driven</span>}
                      {memberCounts[channel.id] ? <span>· {memberCounts[channel.id]} {memberCounts[channel.id] === 1 ? 'member' : 'members'}</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        {recent.length ? (
          <section aria-label="Recent activity" className="grid gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Recent activity</h3>
            <ul className="grid gap-1">
              {recent.map((turn) => (
                <li className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-(--ui-surface-secondary)" key={turn.turnId}>
                  <MemberAvatar profileId={turn.profileId} size="sm" />
                  <p className="min-w-0 truncate text-sm text-(--ui-text-secondary)"><span className="font-medium text-foreground">{displayName(turn.profileId)}</span> {turnStateLabel(turn.state)}{channelName(turn.events[0]?.channelId || '') ? ` in ${channelName(turn.events[0].channelId)}` : ''}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p aria-live="polite" className="sr-only" role="status">{announcement}</p>
      </div>
    </div>
  )
}
