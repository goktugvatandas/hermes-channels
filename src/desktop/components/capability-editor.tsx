import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { StudioSave } from '../studio-save-coordinator'
import type { SkillState } from '../types'

export function CapabilityEditor({ api, profile, save }: { api: CrewApi; profile: string; save: StudioSave }) {
  const [skills, setSkills] = useState<SkillState[]>([])
  const [toolsets, setToolsets] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => { void Promise.all([api.listSkills(profile), api.getToolsets(profile)]).then(([nextSkills, tools]) => { setSkills(nextSkills); setToolsets(tools.enabled.join(',')) }) }, [api, profile])

  function toggle(name: string) {
    const next = skills.map((item) => item.name === name ? { ...item, enabled: !item.enabled } : item)
    setSkills(next)
    void save(`${profile}:skills`, () => api.updateSkills(profile, next.filter((item) => item.enabled).map((item) => item.name))).catch(() => undefined)
  }

  return (
    <section className="grid gap-4">
      <div><h3 className="text-sm font-semibold">Skills</h3><p className="mt-1 text-xs text-(--ui-text-tertiary)">Choose the capabilities available to this agent.</p></div>
      <input aria-label="Search skills" className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2 py-1.5 text-xs" onChange={(event) => setQuery(event.target.value)} placeholder="Search skills…" value={query} />
      <fieldset className="grid"><legend className="sr-only">Skills</legend>{skills.filter((skill) => skill.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.enabled) - Number(a.enabled)).map((skill) => <label className="flex items-center justify-between border-b border-(--ui-stroke-secondary) py-3 text-xs" key={skill.name}><span><strong>{skill.name}</strong><span className="ml-2 text-(--ui-text-tertiary)">{skill.enabled ? 'Enabled' : 'Available'}</span></span><input aria-label={skill.name} checked={skill.enabled} onChange={() => toggle(skill.name)} role="switch" type="checkbox" /></label>)}</fieldset>
      <section className="grid gap-2 border-t border-(--ui-stroke-secondary) pt-4"><h3 className="text-sm font-semibold">Toolsets</h3><label className="grid gap-1 text-xs">Enabled toolsets<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setToolsets(event.target.value)} value={toolsets} /></label><button className="justify-self-end text-xs hover:underline" onClick={() => void save(`${profile}:toolsets`, () => api.updateToolsets(profile, toolsets.split(',').map((item) => item.trim()).filter(Boolean)))} type="button">Save tools</button></section>
    </section>
  )
}
