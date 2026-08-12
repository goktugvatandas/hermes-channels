import { useState, type FormEvent } from 'react'

import type { CrewApi } from '../api'
import type { CrewChannel, HermesProfile, SearchResult } from '../types'

const STATES = [
  'queued',
  'started',
  'streaming',
  'tool_started',
  'tool_finished',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]

export function SearchView({ api, channels, profiles }: {
  api: CrewApi
  channels: CrewChannel[]
  profiles: HermesProfile[]
}) {
  const [q, setQ] = useState('')
  const [channelId, setChannelId] = useState('')
  const [member, setMember] = useState('')
  const [project, setProject] = useState('')
  const [state, setState] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      setResults(await api.search({ q, channelId, member, project, state }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Crew search" className="grid min-h-0 content-start gap-4 overflow-auto p-5">
      <header><h2 className="text-lg font-semibold">Search Crew</h2><p className="text-xs text-(--ui-text-tertiary)">Search local messages and durable activity.</p></header>
      <form className="grid gap-3 rounded border border-(--ui-stroke-secondary) p-3" onSubmit={submit}>
        <label className="grid gap-1 text-xs">Search text<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setQ(event.target.value)} value={q} /></label>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <label className="grid gap-1 text-xs">Channel filter<select className="rounded border border-(--ui-stroke-secondary) bg-background p-2" onChange={(event) => setChannelId(event.target.value)} value={channelId}><option value="">All channels</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
          <label className="grid gap-1 text-xs">Member filter<select className="rounded border border-(--ui-stroke-secondary) bg-background p-2" onChange={(event) => setMember(event.target.value)} value={member}><option value="">All members</option>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>
          <label className="grid gap-1 text-xs">Project filter<input className="rounded border border-(--ui-stroke-secondary) bg-transparent p-2" onChange={(event) => setProject(event.target.value)} placeholder="Project id" value={project} /></label>
          <label className="grid gap-1 text-xs">State filter<select className="rounded border border-(--ui-stroke-secondary) bg-background p-2" onChange={(event) => setState(event.target.value)} value={state}><option value="">All states</option>{STATES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        </div>
        <button className="justify-self-end rounded bg-(--ui-accent) px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy} type="submit">{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
      <ol className="grid gap-2">
        {results.map((result) => <li className="rounded border border-(--ui-stroke-secondary) p-3" key={`${result.kind}:${result.sourceId}`}>
          <header className="flex flex-wrap gap-2 text-[11px] text-(--ui-text-tertiary)"><strong className="text-foreground">{result.kind}</strong>{result.memberId ? <span>{result.memberId}</span> : null}{result.projectId ? <span>{result.projectId}</span> : null}{result.state ? <span>{result.state}</span> : null}<span>{new Date(result.createdAt).toLocaleString()}</span></header>
          <p className="mt-2 whitespace-pre-wrap text-sm">{result.text}</p>
          <details className="mt-2 text-xs"><summary className="cursor-pointer">Inspect</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre></details>
        </li>)}
      </ol>
    </section>
  )
}
