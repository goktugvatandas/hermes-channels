import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { mentionHandle, usePresentation } from '../presentation'
import type { CrewChannel, CrewSchedule, HermesProfile } from '../types'

const PRESETS = [
  { label: 'Every weekday at 9:00', value: '0 9 * * 1-5' },
  { label: 'Every day at 9:00', value: '0 9 * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 30 minutes', value: 'every 30m' },
  { label: 'Custom…', value: '' },
] as const

/**
 * Recurring channel messages, executed by Hermes' own cron: each schedule is
 * a real host cron job (a tokenless script job) whose firing posts a message
 * through normal Crew routing — mention agents and the message starts a
 * relay just like a human kickoff.
 */
export function SchedulesEditor({ api, channels, profiles }: { api: CrewApi; channels: CrewChannel[]; profiles: HermesProfile[] }) {
  const presentation = usePresentation()
  const [schedules, setSchedules] = useState<CrewSchedule[] | null>(null)
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<string>(PRESETS[0].value)
  const [custom, setCustom] = useState('')
  const [channelId, setChannelId] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  function refresh() {
    void api.listSchedules().then(setSchedules).catch(() => setError('Schedules could not be loaded'))
  }
  useEffect(refresh, [api])
  useEffect(() => { if (!channelId && channels.length) setChannelId(channels[0].id) }, [channelId, channels])

  const cadence = preset || custom

  function mentionsFrom(text: string): string[] {
    const tokens = new Set([...text.matchAll(/(?:^|[\s([{])@([\w-]+)/g)].map((match) => match[1].toLowerCase()))
    return profiles
      .filter((profile) => tokens.has(profile.name.toLowerCase()) || tokens.has(mentionHandle(presentation, profile.name).toLowerCase()))
      .map((profile) => profile.name)
  }

  async function create() {
    if (!name.trim() || !cadence.trim() || !channelId || !content.trim()) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await api.createSchedule({
        name: name.trim(),
        schedule: cadence.trim(),
        channelId,
        content: content.trim(),
        mentions: mentionsFrom(content),
      })
      setName('')
      setContent('')
      setStatus('Schedule created')
      refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Schedule could not be created')
    } finally {
      setBusy(false)
    }
  }

  async function act(action: () => Promise<unknown>, done: string) {
    setError('')
    setStatus('')
    try {
      await action()
      setStatus(done)
      refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Action failed')
    }
  }

  const channelName = (id: string | null) => channels.find((channel) => channel.id === id)?.name

  return (
    <section aria-label="Schedules" className="grid content-start gap-5">
      <div>
        <h3 className="text-sm font-semibold">Schedules</h3>
        <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">
          Recurring channel messages, run by Hermes&apos; own cron (they also
          appear on the host&apos;s Cron page). The trigger costs no model
          tokens; mention agents in the message and each firing kicks off a
          normal relay. Firing requires the Hermes Desktop app or a running
          gateway.
        </p>
      </div>

      <form aria-label="New schedule" className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) p-4" onSubmit={(event) => { event.preventDefault(); void create() }}>
        <strong className="text-sm font-medium">New schedule</strong>
        <div className="grid gap-3 @xl:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">Name
            <input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setName(event.target.value)} placeholder="Morning standup" value={name} />
          </label>
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">Channel
            <select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setChannelId(event.target.value)} value={channelId}>
              {channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">Cadence
            <select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setPreset(event.target.value)} value={preset}>
              {PRESETS.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          {preset === '' ? (
            <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">Custom cadence
              <input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setCustom(event.target.value)} placeholder='cron ("0 9 * * *") or "every 2h"' value={custom} />
            </label>
          ) : null}
        </div>
        <label className="grid gap-1 text-xs font-medium text-(--ui-text-secondary)">Message
          <textarea className="min-h-20 rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setContent(event.target.value)} placeholder="@Odin kick off the daily standup — everyone report status." value={content} />
          <span className="font-normal text-(--ui-text-tertiary)">@mentions route exactly like a message you type yourself.</span>
        </label>
        <button className="justify-self-start rounded-lg bg-(--ui-accent) px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !name.trim() || !cadence.trim() || !content.trim() || !channelId} type="submit">Create schedule</button>
      </form>

      {schedules === null ? (
        <div aria-label="Loading schedules" className="grid gap-3"><span className="h-16 animate-pulse rounded bg-(--ui-surface-secondary)" /></div>
      ) : schedules.length === 0 ? (
        <p className="rounded-xl border border-dashed border-(--ui-stroke-secondary) px-4 py-6 text-center text-sm text-(--ui-text-tertiary)">No schedules yet. The classic first one: a weekday standup kickoff.</p>
      ) : (
        <ul className="grid gap-2">
          {schedules.map((schedule) => (
            <li className="grid gap-1.5 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3" key={schedule.id}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm font-medium">{schedule.name}</strong>
                <span className="rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 text-[11px] text-(--ui-text-secondary)">{schedule.schedule}</span>
                {channelName(schedule.channelId) ? <span className="text-[11px] text-(--ui-text-tertiary)">#{channelName(schedule.channelId)}</span> : null}
                {!schedule.enabled ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600">Paused</span> : null}
              </div>
              {schedule.content ? <p className="truncate text-xs text-(--ui-text-secondary)">{schedule.content}</p> : null}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button className="rounded-md border border-(--ui-stroke-secondary) px-2 py-0.5 font-medium hover:bg-(--ui-surface-secondary)" onClick={() => void act(() => api.triggerSchedule(schedule.id), `${schedule.name} will fire on the next tick`)} type="button">Run now</button>
                <button className="rounded-md border border-(--ui-stroke-secondary) px-2 py-0.5 font-medium hover:bg-(--ui-surface-secondary)" onClick={() => void act(() => api.setSchedulePaused(schedule.id, schedule.enabled), schedule.enabled ? `${schedule.name} paused` : `${schedule.name} resumed`)} type="button">{schedule.enabled ? 'Pause' : 'Resume'}</button>
                <button className="rounded-md px-2 py-0.5 font-medium text-red-500 hover:bg-red-500/10" onClick={() => void act(() => api.deleteSchedule(schedule.id), `${schedule.name} deleted`)} type="button">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <span aria-live="polite" className="text-xs text-(--ui-text-tertiary)" role="status">{status}</span>
        {error ? <p className="text-xs text-amber-500" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
