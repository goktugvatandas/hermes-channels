import { host } from '@hermes/plugin-sdk'

/**
 * True when running inside the Hermes web dashboard host.
 *
 * Detection uses a plugin-owned marker set by the dashboard entry, NOT the
 * host's SDK globals: Hermes Desktop's plugin loader also assigns
 * `__HERMES_PLUGIN_SDK__` to globalThis (timing-dependent on plugin load
 * order), so sniffing it misidentified the desktop as the dashboard.
 */
export function isDashboardHost(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __HERMES_CHANNELS_HOST__?: string }).__HERMES_CHANNELS_HOST__ === 'dashboard'
}

/**
 * Jump from Channels into the agent's native Hermes session for hands-on work.
 * Both hosts navigate in-app: the dashboard resumes in its chat, Desktop
 * routes straight to the session view.
 */
export function openAgentSession(sessionId: string): void {
  if (isDashboardHost()) {
    host.navigate(`/chat?resume=${encodeURIComponent(sessionId)}`)
    return
  }
  // Hermes Desktop routes chat sessions as /<sessionId>: any single-segment
  // path outside the core route table resolves to the chat view with that
  // session loaded (see the host's routes module). Earlier attempts at this
  // failed only because host misdetection sent them down the dashboard branch.
  host.navigate(`/${encodeURIComponent(sessionId)}`)
}
