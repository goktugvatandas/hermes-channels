import { useEffect, useMemo, useState } from 'react'

import type { CrewApi } from '../api'
import { ChannelHeader } from '../components/channel-header'
import { CrewComposer } from '../components/crew-composer'
import { MessageList } from '../components/message-list'
import { summarizeTurns, type DeliveryState, type TurnSummary } from '../conversation-model'
import type { ChannelUiSnapshot } from '../channel-ui-state'
import type { CrewChannel, CrewMessage, EventFrame, HermesProfile, MessageReceipt } from '../types'

interface ChannelViewProps {
  api: CrewApi
  channel: CrewChannel
  profiles: HermesProfile[]
  messageRevision: number
  membershipRevision?: number
  onOpenThread(message: CrewMessage): void
  uiSnapshot?: ChannelUiSnapshot
  onUiSnapshot?(patch: Partial<ChannelUiSnapshot>): void
  events?: EventFrame[]
  onOpenDetails(): void
  onNavigate?(view: 'home' | 'channels' | 'workshop' | 'search' | 'profile' | 'settings'): void
}

export function ChannelView({ api, channel, profiles, messageRevision, membershipRevision = 0, onOpenThread, onOpenDetails, uiSnapshot, onUiSnapshot, events = [], onNavigate }: ChannelViewProps) {
  const [messages, setMessages] = useState<CrewMessage[]>([])
  const [deliveryById, setDeliveryById] = useState<Record<string, DeliveryState>>({})
  const [pendingTurnIds, setPendingTurnIds] = useState<string[]>([])
  const [memberIds, setMemberIds] = useState<string[]>([])

  useEffect(() => {
    let current = true
    void api.listChannelMembers(channel.id)
      .then((members) => {
        if (current) setMemberIds(members.map((member) => member.profileId))
      })
      .catch(() => {
        // The chip cluster stays empty until a later render succeeds.
      })
    return () => { current = false }
  }, [api, channel.id, membershipRevision])
  useEffect(() => {
    let current = true
    void api.listMessages(channel.id).then((items) => {
      if (!current) return
      setMessages((existing) => [...items, ...existing.filter((message) => message.id.startsWith('local:'))])
    })
    return () => { current = false }
  }, [api, channel.id, messageRevision, pendingTurnIds.join(',')])

  useEffect(() => {
    setMessages([])
    setPendingTurnIds([])
    setDeliveryById({})
  }, [channel.id])

  const pendingTurns = useMemo(() => {
    const summaries = new Map(summarizeTurns(events).map((turn) => [turn.turnId, turn]))
    return pendingTurnIds.map((turnId): TurnSummary => summaries.get(turnId) || {
      turnId,
      profileId: channel.defaultResponderProfile || 'agent',
      state: 'queued',
      events: [],
      messageId: null,
      terminal: false,
      sessionId: null,
      triggerMessageId: null,
      triggerExcerpt: null,
    }).filter((turn) => !turn.messageId || !messages.some((message) => message.id === turn.messageId))
  }, [channel.defaultResponderProfile, events, messages, pendingTurnIds])
  const turnByMessageId = useMemo(() => new Map(
    summarizeTurns(events)
      .filter((turn) => turn.messageId)
      .map((turn) => [turn.messageId as string, turn]),
  ), [events])
  const latestCompletion = [...events].reverse().find((event) => event.type === 'completed')
  const completionProfile = latestCompletion && typeof latestCompletion.payload.profileId === 'string'
    ? profiles.find((profile) => profile.name === latestCompletion.payload.profileId)?.name || latestCompletion.payload.profileId
    : null
  const channelProfiles = useMemo(
    () => profiles.filter((profile) => memberIds.includes(profile.name)),
    [memberIds, profiles],
  )

  function pending(message: CrewMessage) {
    setMessages((current) => [...current.filter((item) => item.id !== message.id), message])
    setDeliveryById((current) => ({ ...current, [message.id]: 'sending' }))
  }

  function failed(messageId: string) {
    setDeliveryById((current) => ({ ...current, [messageId]: 'failed' }))
  }

  function sent(receipt: MessageReceipt, pendingMessageId: string) {
    setMessages((current) => [...current.filter((message) => message.id !== pendingMessageId && message.id !== receipt.message.id), receipt.message])
    setDeliveryById((current) => {
      const next = { ...current }
      delete next[pendingMessageId]
      return next
    })
    setPendingTurnIds((current) => [...new Set([...current, ...receipt.turnIds])])
  }

  return (
    <section aria-label={`#${channel.name}`} className="flex min-h-0 flex-col">
      <ChannelHeader channel={channel} memberIds={memberIds} onOpenDetails={onOpenDetails} />
      <MessageList deliveryById={deliveryById} initialScrollTop={uiSnapshot?.scrollTop} key={channel.id} messages={messages} onReply={onOpenThread} onScrollTop={(scrollTop) => onUiSnapshot?.({ scrollTop })} pendingTurns={pendingTurns} profiles={profiles} turnByMessageId={turnByMessageId} />
      <CrewComposer api={api} channelId={channel.id} onFailed={failed} onNavigate={onNavigate} onPending={pending} onSent={sent} onValueChange={(draft) => onUiSnapshot?.({ draft })} profiles={channelProfiles} value={uiSnapshot?.draft} />
      <p aria-live="polite" className="sr-only" role="status">{completionProfile ? `${completionProfile} responded` : ''}</p>
    </section>
  )
}
