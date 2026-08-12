import { useEffect, useState } from 'react'

import type { CrewApi } from '../api'
import { CrewComposer } from '../components/crew-composer'
import { MessageList } from '../components/message-list'
import type { CrewChannel, CrewMessage, HermesProfile } from '../types'

interface ChannelViewProps {
  api: CrewApi
  channel: CrewChannel
  profiles: HermesProfile[]
  onOpenThread(message: CrewMessage): void
}

export function ChannelView({ api, channel, profiles, onOpenThread }: ChannelViewProps) {
  const [messages, setMessages] = useState<CrewMessage[]>([])
  useEffect(() => {
    let current = true
    setMessages([])
    void api.listMessages(channel.id).then((items) => { if (current) setMessages(items) })
    return () => { current = false }
  }, [api, channel.id])

  return (
    <section aria-label={`#${channel.name}`} className="flex min-h-0 flex-col">
      <header className="border-b border-(--ui-stroke-secondary) px-4 py-3">
        <h2 className="font-semibold">#{channel.name}</h2>
        <p className="text-xs text-(--ui-text-secondary)">{channel.topic || channel.purpose || 'Shared crew channel'}</p>
      </header>
      <MessageList messages={messages.filter((message) => !message.rootMessageId)} onReply={onOpenThread} />
      <CrewComposer api={api} channelId={channel.id} onSent={(message) => setMessages((current) => [...current, message])} profiles={profiles} />
    </section>
  )
}
