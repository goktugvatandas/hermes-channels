/**
 * Interop with Hermes Bot Mode (github.com/NousResearch/Hermes-Bot-Mode).
 *
 * Bot Mode is a sibling desktop plugin that presents each Hermes profile as a
 * "bot" with its own chat — effectively the direct-message surface for crew
 * agents. Two touch points keep the plugins feeling like one product:
 *
 *  - avatars: Crew stores avatars in channels.db; Bot Mode reads the profile
 *    asset store (`profiles.get_asset`). Mirroring Crew avatar saves into
 *    `profiles.set_asset` gives both UIs the same face for the same agent.
 *  - direct messages: `host.newChat(profile)` opens a fresh chat with the
 *    agent's profile — the same conversation surface Bot Mode's rows open.
 *
 * Everything here is feature-detected and best-effort: older hosts without
 * these RPCs, and the dashboard host (no gateway bridge), degrade to no-ops.
 */

import { host } from '@hermes/plugin-sdk'

function isDashboardHost(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __HERMES_CHANNELS_HOST__?: string }).__HERMES_CHANNELS_HOST__ === 'dashboard'
}

/** Push a Crew avatar (data URL, or null to clear) into the profile asset store. */
export function mirrorAvatarToBotMode(profileId: string, avatar: string | null): void {
  if (isDashboardHost()) return
  void host.request(
    'profiles.set_asset',
    avatar
      ? { name: profileId, asset: 'avatar', data: avatar }
      : { name: profileId, asset: 'avatar', clear: true },
  ).catch(() => {
    // Older gateway without the asset store — Bot Mode falls back to its
    // own shape avatars; nothing to do from our side.
  })
}

export function canOpenDirectMessage(): boolean {
  return !isDashboardHost() && typeof host.newChat === 'function'
}

/** Open a direct chat with the agent's profile (Bot Mode's DM surface). */
export function openDirectMessage(profileId: string): void {
  if (!canOpenDirectMessage()) return
  host.newChat?.(profileId)
}

interface ProfilesListResponse {
  profiles?: Array<{ name?: string; last_session?: { id?: string } | null }>
}

async function latestDirectSession(profileId: string): Promise<string | null> {
  // profiles.list's last_session already skips crew worker sessions (they
  // carry the host's internal source), so this is the agent's real DM.
  const response = await host.request<ProfilesListResponse>('profiles.list', {})
  const id = response?.profiles?.find((profile) => profile.name === profileId)?.last_session?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Open the agent's chat the way a Bot Mode row does: resume the latest
 * conversation under that profile, else start a fresh one. Switching the
 * gateway profile is what highlights the agent in Bot Mode's Bots pane.
 * Falls back to plain session navigation on shells without the newer APIs.
 */
export async function openAgentChat(profileId: string): Promise<void> {
  if (isDashboardHost()) return
  let last: string | null = null
  try {
    last = await latestDirectSession(profileId)
  } catch {
    // Roster probe failed — fall through to a fresh chat.
  }
  try {
    if (last && typeof host.openSession === 'function') {
      await host.openSession(last, { profile: profileId })
      return
    }
    if (typeof host.newChat === 'function') {
      host.newChat(profileId)
      return
    }
    host.navigate(last ? `/${encodeURIComponent(last)}` : '/')
  } catch {
    host.navigate('/')
  }
}

interface ProfileAssetResponse {
  found?: boolean
  data?: string
}

/** Fetch the profile's stored avatar (data URL) from the host asset store. */
export async function pullProfileAvatar(profileId: string): Promise<string | null> {
  if (isDashboardHost()) return null
  try {
    const response = await host.request<ProfileAssetResponse>('profiles.get_asset', {
      name: profileId,
      asset: 'avatar',
    })
    const data = response?.found ? response.data : null
    return typeof data === 'string' && data.startsWith('data:image/') ? data : null
  } catch {
    return null
  }
}

const BOT_MODE_META_KEY = 'hermes.plugin.hermes-bots.bot-meta'

export interface BotModeMeta {
  image: string | null
  color: string | null
  shape: string | null
}

/**
 * Bot Mode keeps per-bot appearance in its plugin storage. Shape avatars
 * never reach the profile asset store, but the record is plain localStorage —
 * reading it lets Channels share the same look (image, or at least the hue).
 */
// The meta blob can carry per-bot data-URL images (hundreds of KB) and this
// is read per avatar per render — parse it at most once per short window.
let metaCache: { at: number; record: Record<string, { image?: unknown; color?: unknown; shape?: unknown }> } | null = null
const META_CACHE_MS = 5_000

function botModeMetaRecord(): Record<string, { image?: unknown; color?: unknown; shape?: unknown }> {
  const now = Date.now()
  if (metaCache && now - metaCache.at < META_CACHE_MS) return metaCache.record
  let record: Record<string, { image?: unknown; color?: unknown; shape?: unknown }> = {}
  try {
    const raw = window.localStorage.getItem(BOT_MODE_META_KEY)
    if (raw) record = JSON.parse(raw) as typeof record
  } catch {
    record = {}
  }
  metaCache = { at: now, record }
  return record
}

export function readBotModeMeta(profileId: string): BotModeMeta {
  const empty: BotModeMeta = { image: null, color: null, shape: null }
  if (isDashboardHost() || typeof window === 'undefined') return empty
  try {
    const record = botModeMetaRecord()
    const entry = record?.[profileId]
    if (!entry || typeof entry !== 'object') return empty
    const image = typeof entry.image === 'string' && entry.image.startsWith('data:image/')
      ? entry.image
      : null
    const color = typeof entry.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.color)
      ? entry.color
      : null
    const shape = typeof entry.shape === 'string' && /^[a-z-]+$/.test(entry.shape) ? entry.shape : null
    return { image, color, shape }
  } catch {
    return empty
  }
}
