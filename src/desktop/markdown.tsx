import type { ReactNode } from 'react'

/**
 * Deterministic, dependency-free renderer for the Markdown subset agents
 * actually produce: paragraphs, fenced code, lists, quotes, headings, inline
 * code/bold/italic, links, and @mentions. Builds React nodes only — no HTML
 * strings — so message content can never inject markup.
 */

export interface MarkdownOptions {
  mentionable?: Set<string>
}

const INLINE_TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|((?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[[^\]\n]+\]\(https?:[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:])|(@[\w-]+)/g
const LINK = /^\[([^\]]+)\]\((https?:[^)\s]+)\)$/

function renderInline(text: string, options: MarkdownOptions, keyPrefix: string, depth = 0): ReactNode[] {
  if (depth > 2) return [text]
  const nodes: ReactNode[] = []
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const key = `${keyPrefix}:${index++}`
    if (token.startsWith('`')) {
      nodes.push(<code className="rounded bg-(--ui-surface-secondary) px-1 py-px font-mono text-[0.85em]" key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong className="font-semibold" key={key}>{renderInline(token.slice(2, -2), options, key, depth + 1)}</strong>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), options, key, depth + 1)}</em>)
    } else if (token.startsWith('[')) {
      const link = LINK.exec(token)
      if (link) nodes.push(<a className="text-(--ui-accent) underline decoration-(--ui-accent)/40 underline-offset-2 hover:decoration-(--ui-accent)" href={link[2]} key={key} rel="noreferrer" target="_blank">{link[1]}</a>)
      else nodes.push(token)
    } else if (token.startsWith('http')) {
      nodes.push(<a className="break-all text-(--ui-accent) underline decoration-(--ui-accent)/40 underline-offset-2 hover:decoration-(--ui-accent)" href={token} key={key} rel="noreferrer" target="_blank">{token}</a>)
    } else if (token.startsWith('@')) {
      if (options.mentionable?.has(token.slice(1).toLowerCase())) {
        nodes.push(<span className="rounded bg-(--ui-accent)/10 px-0.5 font-medium text-(--ui-accent)" key={key}>{token}</span>)
      } else {
        nodes.push(token)
      }
    }
    cursor = start + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

const UNORDERED = /^\s{0,3}[-*•]\s+(.*)$/
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/
const HEADING = /^#{1,4}\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const FENCE = /^\s{0,3}```/

export function renderMarkdown(text: string, options: MarkdownOptions = {}): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let key = 0

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push(<p className="whitespace-pre-wrap" key={`p:${key++}`}>{renderInline(paragraph.join('\n'), options, `p:${key}`)}</p>)
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FENCE.test(line)) {
      flushParagraph()
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      blocks.push(<pre className="my-1 overflow-x-auto rounded-lg bg-(--ui-surface-secondary) p-3 font-mono text-xs leading-5" key={`f:${key++}`}><code>{body.join('\n')}</code></pre>)
      continue
    }
    if (UNORDERED.test(line) || ORDERED.test(line)) {
      flushParagraph()
      const ordered = ORDERED.test(line)
      const pattern = ordered ? ORDERED : UNORDERED
      const items: string[] = []
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(pattern.exec(lines[index])![1])
        index += 1
      }
      index -= 1
      const listItems = items.map((item, itemIndex) => <li key={`i:${itemIndex}`}>{renderInline(item, options, `l:${key}:${itemIndex}`)}</li>)
      blocks.push(ordered
        ? <ol className="my-1 grid list-decimal gap-0.5 pl-5" key={`o:${key++}`}>{listItems}</ol>
        : <ul className="my-1 grid list-disc gap-0.5 pl-5" key={`u:${key++}`}>{listItems}</ul>)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push(<p className="font-semibold" key={`h:${key++}`}>{renderInline(heading[1], options, `h:${key}`)}</p>)
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flushParagraph()
      const body: string[] = [quote[1]]
      while (index + 1 < lines.length && QUOTE.test(lines[index + 1])) {
        index += 1
        body.push(QUOTE.exec(lines[index])![1])
      }
      blocks.push(<blockquote className="my-1 whitespace-pre-wrap border-l-2 border-(--ui-stroke-secondary) pl-3 text-(--ui-text-secondary)" key={`q:${key++}`}>{renderInline(body.join('\n'), options, `q:${key}`)}</blockquote>)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}
