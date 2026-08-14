import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { StudioSave } from '../studio-save-coordinator'
import type { CrewChannel, CrewMember, ProjectRef } from '../types'

interface ProjectOption {
  id: string
  name: string
  primaryPath?: string | null
  archived?: boolean
}

export function WorkspaceEditor({ api, channels, member, profile, onMember, save: persist }: { api: CrewApi; channels: CrewChannel[]; member: CrewMember; profile: string; onMember(member: CrewMember): void; save: StudioSave }) {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [defaultProjectId, setDefaultProjectId] = useState(member.defaultProject?.projectId || '')
  const [allowed, setAllowed] = useState<Record<string, string[]>>(() => Object.fromEntries(channels.map((channel) => [channel.id, channel.allowedProjects])))
  useEffect(() => {
    setDefaultProjectId(member.defaultProject?.projectId || '')
    setAllowed(Object.fromEntries(channels.map((channel) => [channel.id, channel.allowedProjects])))
    void api.listProjects(profile).then((items) => setProjects((items as unknown as ProjectOption[]).filter((item) => !item.archived)))
  }, [api, channels, member.defaultProject?.projectId, profile])

  function toggle(channelId: string, projectId: string) {
    setAllowed((current) => {
      const values = current[channelId] || []
      return { ...current, [channelId]: values.includes(projectId) ? values.filter((item) => item !== projectId) : [...values, projectId] }
    })
  }

  async function save() {
    const project = projects.find((item) => item.id === defaultProjectId)
    const defaultProject: ProjectRef | null = project ? { mode: 'project', profile, projectId: project.id, label: project.name, cwd: project.primaryPath || null } : null
    const memberResult = await persist(`${profile}:workspace:default`, () => api.updateMember(profile, { defaultProject }))
    if (memberResult.current) onMember(memberResult.value)
    await persist(`${profile}:workspace:channels`, () => Promise.all(channels.map((channel) => api.patchChannel(channel.id, { allowedProjects: allowed[channel.id] || [] }))))
  }

  return (
    <section className="grid gap-3 rounded-lg border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Workspace · Permissions</h3>
      <p className="text-xs text-(--ui-text-tertiary)">These selections narrow channel routing. Hermes execution and sandbox settings enforce filesystem access.</p>
      <label className="grid gap-1 text-xs">Default project<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background p-2" onChange={(event) => setDefaultProjectId(event.target.value)} value={defaultProjectId}><option value="">Global / profile default</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {channels.map((channel) => <fieldset className="grid gap-1" key={channel.id}><legend className="text-xs font-semibold">Allowed in #{channel.name}</legend>{projects.map((project) => <label className="flex items-center gap-2 text-xs" key={project.id}><input aria-label={`Allow ${project.name} in #${channel.name}`} checked={(allowed[channel.id] || []).includes(project.id)} onChange={() => toggle(channel.id, project.id)} type="checkbox" />{project.name}</label>)}</fieldset>)}
      <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-xs text-white" onClick={() => void save()} type="button">Save workspace</button>
    </section>
  )
}
