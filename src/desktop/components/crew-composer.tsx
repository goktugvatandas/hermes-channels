import { useState, type FormEvent } from 'react'

import type { CrewApi } from '../api'
import type { CrewMessage, HermesProfile, ProjectRef } from '../types'
import { ProjectPicker } from './project-picker'

interface CrewComposerProps {
  api: CrewApi
  channelId: string
  profiles: HermesProfile[]
  rootMessageId?: string | null
  fixedProject?: ProjectRef | null
  onSent(message: CrewMessage): void
}

export function CrewComposer({ api, channelId, profiles, rootMessageId = null, fixedProject, onSent }: CrewComposerProps) {
  const [content, setContent] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [project, setProject] = useState<ProjectRef>(fixedProject || { mode: 'inherit' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const projectReady = project.mode !== 'project' || Boolean(project.profile && project.projectId && project.cwd)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!content.trim() || !projectReady) return
    setSending(true)
    setError('')
    try {
      const receipt = await api.createMessage(channelId, {
        content: content.trim(),
        idempotencyKey: crypto.randomUUID(),
        mentions,
        rootMessageId,
        project: fixedProject || project,
        attachments: [],
      })
      onSent(receipt.message)
      setContent('')
      setMentions([])
      if (!rootMessageId) setProject({ mode: 'inherit' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Message could not be sent')
    } finally {
      setSending(false)
    }
  }

  function toggleMention(profile: string) {
    setMentions((current) => current.includes(profile) ? current.filter((item) => item !== profile) : [...current, profile])
  }

  return (
    <form aria-label={rootMessageId ? 'Thread message' : 'Channel message'} className="grid gap-2 border-t border-(--ui-stroke-secondary) p-3" onSubmit={submit}>
      <div className="flex flex-wrap gap-1">
        <button aria-pressed={mentions.length === profiles.length && profiles.length > 0} className="rounded-full border border-(--ui-stroke-secondary) px-2 py-1 text-xs" onClick={() => setMentions(mentions.length === profiles.length ? [] : profiles.map((profile) => profile.name))} type="button">@all</button>
        {profiles.map((profile) => (
          <button aria-pressed={mentions.includes(profile.name)} className="rounded-full border border-(--ui-stroke-secondary) px-2 py-1 text-xs" key={profile.name} onClick={() => toggleMention(profile.name)} type="button">@{profile.name}</button>
        ))}
      </div>
      {fixedProject ? <p className="text-xs text-(--ui-text-tertiary)">Project: {fixedProject.label || fixedProject.projectId || fixedProject.mode}</p> : <ProjectPicker api={api} onChange={setProject} profiles={profiles} value={project} />}
      <label className="sr-only" htmlFor={`crew-message-${rootMessageId || channelId}`}>Message</label>
      <textarea id={`crew-message-${rootMessageId || channelId}`} className="min-h-20 resize-y rounded border border-(--ui-stroke-secondary) bg-transparent p-2 text-sm" onChange={(event) => setContent(event.target.value)} placeholder="Message your crew…" value={content} />
      {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
      <div className="flex justify-end">
        <button className="rounded bg-(--ui-accent) px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={sending || !content.trim() || !projectReady} type="submit">{sending ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  )
}
