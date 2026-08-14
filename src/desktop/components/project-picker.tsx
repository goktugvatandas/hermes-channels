import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { ThemedSelect } from './themed-select'
import type { HermesProfile, ProjectRef } from '../types'

interface HermesProject {
  id: string
  name: string
  primaryPath?: string | null
  archived?: boolean
}

interface AggregatedProject extends HermesProject {
  /** The profile whose registry owns this entry. */
  profile: string
  /** Disambiguated display label when names collide across profiles. */
  displayName: string
}

interface ProjectPickerProps {
  api: CrewApi
  profiles: HermesProfile[]
  value: ProjectRef
  onChange(project: ProjectRef): void
}

/**
 * Hermes projects are registered per profile, but a directory is a directory:
 * the attachment ref carries the resolved cwd, so any bot can work in any
 * project. The picker therefore aggregates EVERY profile's registry into one
 * list (deduped by path) — switching a channel's bots never hides your
 * projects again.
 */
export function ProjectPicker({ api, profiles, value, onChange }: ProjectPickerProps) {
  const [projects, setProjects] = useState<AggregatedProject[]>([])

  useEffect(() => {
    if (value.mode !== 'project' || profiles.length === 0) {
      setProjects([])
      return
    }
    let current = true
    void Promise.allSettled(
      profiles.map(async (profile) => ({
        profile: profile.name,
        items: (await api.listProjects(profile.name)) as unknown as HermesProject[],
      })),
    ).then((results) => {
      if (!current) return
      const byPath = new Map<string, AggregatedProject>()
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        for (const item of result.value.items) {
          if (item.archived) continue
          const key = item.primaryPath || `${result.value.profile}:${item.id}`
          const isSelected = item.id === value.projectId && result.value.profile === value.profile
          const existing = byPath.get(key)
          const existingIsSelected = existing?.id === value.projectId && existing?.profile === value.profile
          // Prefer the selected registration when duplicate registries point
          // at one cwd, otherwise the controlled composite value disappears.
          if (!existing || (isSelected && !existingIsSelected)) {
            byPath.set(key, { ...item, profile: result.value.profile, displayName: item.name })
          }
        }
      }
      const merged = [...byPath.values()]
      const nameCounts = new Map<string, number>()
      for (const project of merged) {
        nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1)
      }
      for (const project of merged) {
        if ((nameCounts.get(project.name) ?? 0) > 1) {
          project.displayName = `${project.name} (${project.profile})`
        }
      }
      merged.sort((left, right) => left.displayName.localeCompare(right.displayName))
      setProjects(merged)
    })
    return () => { current = false }
  }, [api, profiles, value.mode, value.profile, value.projectId])

  const selectedKey = value.projectId ? `${value.profile ?? ''}::${value.projectId}` : ''

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-tertiary)">
        Project scope
        <ThemedSelect
          ariaLabel="Project scope"
          onChange={(next) => {
            const mode = next as ProjectRef['mode']
            if (mode === 'project') onChange({ mode, profile: profiles[0]?.name || null })
            else onChange({ mode })
          }}
          options={[
            { value: 'inherit', label: 'Inherit' },
            { value: 'global', label: 'Global' },
            { value: 'project', label: 'Project' },
          ]}
          value={value.mode}
        />
      </label>
      {value.mode === 'project' ? (
        <label className="flex items-center gap-1.5 text-[11px] text-(--ui-text-tertiary)">
          Hermes project
          <ThemedSelect
            ariaLabel="Hermes project"
            onChange={(next) => {
              const project = projects.find(
                (item) => `${item.profile}::${item.id}` === next,
              )
              onChange(project
                ? {
                    mode: 'project',
                    profile: project.profile,
                    projectId: project.id,
                    label: project.name,
                    cwd: project.primaryPath || null,
                  }
                : { mode: 'project', profile: profiles[0]?.name || null })
            }}
            options={[
              { value: '__choose__', label: 'Choose project' },
              ...projects.map((project) => ({
                value: `${project.profile}::${project.id}`,
                label: project.displayName,
              })),
            ]}
            value={selectedKey || '__choose__'}
          />
        </label>
      ) : null}
    </div>
  )
}
