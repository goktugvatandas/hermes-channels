/**
 * One-shot signal from the CHANNELS pane's "+" to Bot Management: navigate,
 * then open the create dialog on arrival. A window event covers the case
 * where Bot Management is already mounted (navigation is a no-op there), and
 * the pending flag covers cross-route mounts — with a TTL so an unconsumed
 * click can't surprise-open the dialog much later.
 */

export const BOT_CREATE_EVENT = 'hermes-channels:new-bot'

const TTL_MS = 10_000

let requestedAt = 0

export function requestBotCreate(): void {
  requestedAt = Date.now()
  window.dispatchEvent(new CustomEvent(BOT_CREATE_EVENT))
}

export function consumeBotCreate(): boolean {
  const fresh = requestedAt > 0 && Date.now() - requestedAt < TTL_MS
  requestedAt = 0
  return fresh
}
