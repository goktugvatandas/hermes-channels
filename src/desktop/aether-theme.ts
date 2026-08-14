/**
 * Aether — the Hermes Channels brand skin for Hermes Desktop.
 *
 * Mint-on-midnight in dark mode (the palette of the Crew logomark),
 * porcelain with deep mint-teal accents in light. Installed into the host's
 * user-theme store on plugin load so the boot-time paint can resolve it
 * synchronously (contributed themes register too late for first paint), and
 * applied as the active skin exactly once — after that the user's Appearance
 * choice always wins.
 */

const AETHER_THEME = {
  name: 'aether',
  label: 'Aether',
  description: 'Hermes Channels · mint on midnight',
  colors: {
    background: '#F7F9F9',
    foreground: '#16162E',
    card: '#FFFFFF',
    cardForeground: '#16162E',
    muted: '#EDF2F1',
    mutedForeground: '#5C6470',
    popover: '#FFFFFF',
    popoverForeground: '#16162E',
    primary: '#0E9F82',
    primaryForeground: '#FFFFFF',
    secondary: '#E4F3EE',
    secondaryForeground: '#1D2B33',
    accent: '#DCF5EC',
    accentForeground: '#123B32',
    border: 'rgba(22, 22, 46, 0.12)',
    input: 'rgba(22, 22, 46, 0.16)',
    ring: '#0E9F82',
    midground: '#12B892',
    composerRing: '#12B892',
    destructive: '#C7304C',
    destructiveForeground: '#FFFFFF',
    sidebarBackground: '#EFF4F2',
    sidebarBorder: 'rgba(22, 22, 46, 0.08)',
    userBubble: '#E1F4EC',
    userBubbleBorder: 'rgba(14, 159, 130, 0.25)',
  },
  darkColors: {
    background: '#131328',
    foreground: '#E9EDF2',
    card: '#1A1A33',
    cardForeground: '#E9EDF2',
    muted: '#22223D',
    mutedForeground: '#9AA3B2',
    popover: '#1C1C36',
    popoverForeground: '#E9EDF2',
    primary: '#3EE6C1',
    primaryForeground: '#0D1B18',
    secondary: '#232345',
    secondaryForeground: '#D9E1E6',
    accent: '#1E3A38',
    accentForeground: '#7BF0D6',
    border: 'rgba(233, 237, 242, 0.12)',
    input: 'rgba(233, 237, 242, 0.16)',
    ring: '#3EE6C1',
    midground: '#3EE6C1',
    composerRing: '#3EE6C1',
    destructive: '#F0546D',
    destructiveForeground: '#16060B',
    sidebarBackground: '#0E0E1F',
    sidebarBorder: 'rgba(233, 237, 242, 0.08)',
    userBubble: '#1D3A35',
    userBubbleBorder: 'rgba(62, 230, 193, 0.3)',
  },
} as const

const USER_THEMES_KEY = 'hermes-desktop-user-themes-v1'
const ACTIVE_SKIN_KEY = 'hermes-desktop-theme-v2'
const APPLIED_FLAG = 'hermes-channels.aether-default-applied-v1'
const SHIPPED_KEY = 'hermes-channels.aether-shipped-v1'

export function installAetherTheme(): void {
  try {
    const raw = window.localStorage.getItem(USER_THEMES_KEY)
    const record: Record<string, unknown> = raw ? JSON.parse(raw) : {}
    // Overwrite only our own untouched copy: if the stored entry differs
    // from what WE last shipped, the user edited it — their version wins.
    const shipped = window.localStorage.getItem(SHIPPED_KEY)
    const existing = record.aether ? JSON.stringify(record.aether) : null
    if (existing !== null && shipped !== null && existing !== shipped) {
      return
    }
    record.aether = AETHER_THEME
    window.localStorage.setItem(USER_THEMES_KEY, JSON.stringify(record))
    window.localStorage.setItem(SHIPPED_KEY, JSON.stringify(AETHER_THEME))

    if (!window.localStorage.getItem(APPLIED_FLAG)) {
      window.localStorage.setItem(APPLIED_FLAG, '1')
      window.localStorage.setItem(ACTIVE_SKIN_KEY, 'aether')
    }
  } catch {
    // Theming is cosmetic; a restricted storage context must not break the plugin.
  }
}
