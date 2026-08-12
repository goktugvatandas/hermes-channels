import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { CrewComposer } from '../components/crew-composer'
import { MessageList } from '../components/message-list'
import type { CrewMessage, HermesProfile } from '../types'

interface ThreadViewProps {
  api: CrewApi
  channelId: string
  root: CrewMessage
  profiles: HermesProfile[]
  onClose(): void
}

export function ThreadView({ api, channelId, root, profiles, onClose }: ThreadViewProps) {
  const [messages, setMessages] = useState<CrewMessage[]>([root])
  useEffect(() => {
    let current = true
    void api.getThread(root.id).then((items) => { if (current) setMessages(items) })
    return () => { current = false }
  }, [api, root.id])
  const inheritedProject = root.project || { mode: 'inherit' as const }
  return (
    <aside aria-label="Thread" className="flex min-h-0 flex-col border-l border-(--ui-stroke-secondary)">
      <header className="flex items-center justify-between border-b border-(--ui-stroke-secondary) p-3">
        <div><h2 className="text-sm font-semibold">Thread</h2>{root.project?.mode === 'project' ? <span className="text-xs text-(--ui-text-tertiary)">{root.project.label || root.project.projectId}</span> : null}</div>
        <button aria-label="Close thread" onClick={onClose} type="button">×</button>
      </header>
      <MessageList messages={messages} />
      <CrewComposer api={api} channelId={channelId} fixedProject={inheritedProject} onSent={(message) => setMessages((current) => [...current, message])} profiles={profiles} rootMessageId={root.id} />
    </aside>
  )
}
