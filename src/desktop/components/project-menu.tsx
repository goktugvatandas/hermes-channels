import { useEffect, useRef, useState } from 'react'

import type { CrewApi } from '../api'
import type { HermesProfile, ProjectRef } from '../types'
import { IconButton } from './icon-button'
import { ProjectPicker } from './project-picker'

interface ProjectMenuProps {
  api: CrewApi
  profiles: HermesProfile[]
  value: ProjectRef
  onChange(project: ProjectRef): void
}

export function projectChipLabel(value: ProjectRef): string | null {
  if (value.mode === 'global') return 'Global'
  if (value.mode === 'project') return value.label || value.projectId || 'Project'
  return null
}

/**
 * Compact project-scope control for the composer footer: a folder icon that
 * opens the scope menu, plus a chip only when the message deviates from the
 * channel default (inherit stays invisible).
 */
export function ProjectMenu({ api, profiles, value, onChange }: ProjectMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const chip = projectChipLabel(value)

  return (
    <div className="relative flex items-center gap-1.5" onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }} ref={rootRef}>
      {chip ? (
        <button className="max-w-40 truncate rounded-full border border-(--ui-accent)/40 bg-(--ui-accent)/10 px-2 py-0.5 text-[11px] font-medium text-(--ui-accent)" onClick={() => setOpen((current) => !current)} title="Change project scope" type="button">{chip}</button>
      ) : null}
      <IconButton aria-expanded={open} codicon="folder" label="Choose project scope" onClick={() => setOpen((current) => !current)} title="Project scope" />
      {open ? (
        <div aria-label="Project scope menu" className="absolute bottom-full right-0 z-20 mb-2 grid w-72 gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-background p-3 shadow-lg" role="group">
          <p className="text-xs text-(--ui-text-tertiary)">Where agents work on this message. Inherit follows the channel default.</p>
          <ProjectPicker api={api} onChange={onChange} profiles={profiles} value={value} />
          <div className="flex justify-end gap-2">
            {value.mode !== 'inherit' ? <button className="rounded-lg px-2.5 py-1 text-xs font-medium text-(--ui-text-secondary) hover:bg-(--ui-surface-secondary)" onClick={() => { onChange({ mode: 'inherit' }); setOpen(false) }} type="button">Reset to default</button> : null}
            <button className="rounded-lg border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs font-medium hover:bg-(--ui-surface-secondary)" onClick={() => setOpen(false)} type="button">Done</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
