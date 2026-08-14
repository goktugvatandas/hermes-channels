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
    <section aria-label="Channels search" className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto grid w-full max-w-3xl content-start gap-4 px-6 py-6">
        <header><h2 className="text-lg font-semibold">Search</h2><p className="mt-0.5 text-sm text-(--ui-text-secondary)">Find messages and durable bot activity across your channels.</p></header>
        <form className="grid gap-3 rounded-2xl border border-(--ui-stroke-secondary) bg-background p-4 shadow-sm" onSubmit={submit}>
          <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Search text<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 text-sm font-normal text-foreground" onChange={(event) => setQ(event.target.value)} placeholder="What are you looking for?" value={q} /></label>
          <div className="grid grid-cols-1 gap-2.5 @2xl:grid-cols-2 @5xl:grid-cols-4">
            <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Channel filter<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1.5 font-normal text-foreground" onChange={(event) => setChannelId(event.target.value)} value={channelId}><option value="">All channels</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
            <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Member filter<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1.5 font-normal text-foreground" onChange={(event) => setMember(event.target.value)} value={member}><option value="">All members</option>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>
            <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">Project filter<input className="rounded-lg border border-(--ui-stroke-secondary) bg-transparent px-2 py-1.5 font-normal text-foreground" onChange={(event) => setProject(event.target.value)} placeholder="Project id" value={project} /></label>
            <label className="grid gap-1.5 text-xs font-medium text-(--ui-text-secondary)">State filter<select className="rounded-lg border border-(--ui-stroke-secondary) bg-background px-2 py-1.5 font-normal text-foreground" onChange={(event) => setState(event.target.value)} value={state}><option value="">All states</option>{STATES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </div>
          <button className="justify-self-end rounded-full bg-(--ui-accent) px-4 py-1.5 text-sm font-medium text-white shadow-sm disabled:opacity-50" disabled={busy} type="submit">{busy ? 'Searching…' : 'Search'}</button>
        </form>
        {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
        <ol className="grid gap-2.5">
          {results.map((result) => <li className="rounded-xl border border-(--ui-stroke-secondary) p-4 transition-colors hover:border-(--ui-accent)/40" key={`${result.kind}:${result.sourceId}`}>
            <header className="flex flex-wrap items-center gap-2 text-[11px] text-(--ui-text-tertiary)"><strong className="rounded-full bg-(--ui-surface-secondary) px-2 py-0.5 font-medium text-foreground">{result.kind}</strong>{result.memberId ? <span>{result.memberId}</span> : null}{result.projectId ? <span>{result.projectId}</span> : null}{result.state ? <span>{result.state}</span> : null}<span className="ml-auto">{new Date(result.createdAt).toLocaleString()}</span></header>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{result.text}</p>
            <details className="mt-2 text-xs"><summary className="cursor-pointer text-(--ui-text-tertiary) hover:text-foreground">Inspect</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-(--ui-surface-secondary) p-3">{JSON.stringify(result, null, 2)}</pre></details>
          </li>)}
        </ol>
      </div>
    </section>
  )
}
