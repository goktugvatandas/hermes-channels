import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import type { SkillState } from '../types'

export function CapabilityEditor({ api, profile }: { api: CrewApi; profile: string }) {
  const [skills, setSkills] = useState<SkillState[]>([])
  const [toolsets, setToolsets] = useState('')
  useEffect(() => { void Promise.all([api.listSkills(profile), api.getToolsets(profile)]).then(([nextSkills, tools]) => { setSkills(nextSkills); setToolsets(tools.enabled.join(',')) }) }, [api, profile])
  return (
    <section className="grid gap-3 rounded border border-(--ui-stroke-secondary) p-3">
      <h3 className="text-sm font-semibold">Capabilities</h3>
      <fieldset className="flex flex-wrap gap-3"><legend className="sr-only">Skills</legend>{skills.map((skill) => <label className="flex items-center gap-1 text-xs" key={skill.name}><input aria-label={skill.name} checked={skill.enabled} onChange={() => setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: !item.enabled } : item))} type="checkbox" />{skill.name}</label>)}</fieldset>
      <button className="justify-self-end text-xs hover:underline" onClick={() => void api.updateSkills(profile, skills.filter((skill) => skill.enabled).map((skill) => skill.name))} type="button">Save skills</button>
      <label className="grid gap-1 text-xs">Toolsets<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setToolsets(event.target.value)} value={toolsets} /></label>
      <button className="justify-self-end text-xs hover:underline" onClick={() => void api.updateToolsets(profile, toolsets.split(',').map((item) => item.trim()).filter(Boolean))} type="button">Save tools</button>
    </section>
  )
}
