import type { CrewMessage } from '../types'

const intentComment = /<!--\s*hermes-crew:intent\b[^\r\n]*?-->/g

interface MessageListProps {
  messages: CrewMessage[]
  onReply?(message: CrewMessage): void
}

export function MessageList({ messages, onReply }: MessageListProps) {
  const replies = new Map<string, number>()
  for (const message of messages) {
    if (message.rootMessageId) replies.set(message.rootMessageId, (replies.get(message.rootMessageId) || 0) + 1)
  }
  return (
    <ol aria-label="Messages" className="grid content-start gap-3 overflow-auto p-4">
      {messages.map((message) => (
        <li className="rounded border border-(--ui-stroke-secondary) p-3" key={message.id}>
          <header className="flex flex-wrap items-center gap-2 text-xs text-(--ui-text-tertiary)">
            <strong className="text-foreground">{message.authorProfileId || (message.authorType === 'user' ? 'You' : 'System')}</strong>
            <span>{new Date(message.createdAt).toLocaleString()}</span>
            {message.modelLabel ? <span>{message.modelLabel}</span> : null}
            {message.project?.mode === 'project' ? <span className="rounded-full bg-(--ui-surface-secondary) px-2 py-0.5">{message.project.label || message.project.projectId}</span> : null}
          </header>
          <p className="mt-2 whitespace-pre-wrap text-sm">{message.content.replace(intentComment, '').trim()}</p>
          <footer className="mt-2 flex items-center gap-2 text-xs">
            {onReply ? <button aria-label="Reply to message" className="hover:underline" onClick={() => onReply(message)} type="button">Reply{replies.get(message.id) ? ` (${replies.get(message.id)})` : ''}</button> : null}
            <button className="hover:underline" onClick={() => void navigator.clipboard?.writeText(message.content)} type="button">Copy</button>
            <button className="hover:underline" title={`Message ${message.id}`} type="button">Inspect</button>
          </footer>
        </li>
      ))}
    </ol>
  )
}
