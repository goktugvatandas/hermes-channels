import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { HermesProfile, ProjectRef } from '../types'

interface HermesProject {
  id: string
  name: string
  primaryPath?: string | null
  archived?: boolean
}

interface ProjectPickerProps {
  api: CrewApi
  profiles: HermesProfile[]
  value: ProjectRef
  onChange(project: ProjectRef): void
}

export function ProjectPicker({ api, profiles, value, onChange }: ProjectPickerProps) {
  const profile = value.profile || profiles[0]?.name || ''
  const [projects, setProjects] = useState<HermesProject[]>([])

  useEffect(() => {
    if (value.mode !== 'project' || !profile) {
      setProjects([])
      return
    }
    let current = true
    void api.listProjects(profile).then((items) => {
      if (current) setProjects(items.filter((item) => !item.archived) as unknown as HermesProject[])
    })
    return () => { current = false }
  }, [api, profile, value.mode])

  return (
    <div className="flex flex-wrap gap-2">
      <label className="grid gap-1 text-[11px] text-(--ui-text-tertiary)">
        Project scope
        <select
          className="rounded border border-(--ui-stroke-secondary) bg-background px-2 py-1 text-xs text-foreground"
          onChange={(event) => {
            const mode = event.target.value as ProjectRef['mode']
            if (mode === 'project') onChange({ mode, profile: profiles[0]?.name || null })
            else onChange({ mode })
          }}
          value={value.mode}
        >
          <option value="inherit">Inherit</option>
          <option value="global">Global</option>
          <option value="project">Project</option>
        </select>
      </label>
      {value.mode === 'project' ? (
        <>
          <label className="grid gap-1 text-[11px] text-(--ui-text-tertiary)">
            Project profile
            <select
              className="rounded border border-(--ui-stroke-secondary) bg-background px-2 py-1 text-xs text-foreground"
              onChange={(event) => onChange({ mode: 'project', profile: event.target.value })}
              value={profile}
            >
              {profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-(--ui-text-tertiary)">
            Hermes project
            <select
              className="rounded border border-(--ui-stroke-secondary) bg-background px-2 py-1 text-xs text-foreground"
              onChange={(event) => {
                const project = projects.find((item) => item.id === event.target.value)
                onChange(project ? { mode: 'project', profile, projectId: project.id, label: project.name, cwd: project.primaryPath || null } : { mode: 'project', profile })
              }}
              value={value.projectId || ''}
            >
              <option value="">Choose project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        </>
      ) : null}
    </div>
  )
}
