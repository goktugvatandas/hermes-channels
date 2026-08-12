declare module '@hermes/plugin-sdk' {
  import type { ReactNode } from 'react'

  export interface PluginRestOptions {
    method?: string
    body?: unknown
    timeoutMs?: number
  }

  export type PluginRest = <T>(
    path: string,
    options?: PluginRestOptions,
  ) => Promise<T>

  export interface PluginContribution {
    id: string
    area: string
    order?: number
    data?: unknown
    render?: () => ReactNode
  }

  export interface PluginContext {
    rest: PluginRest
    socket: (path: string, onMessage: (data: unknown) => void) => () => void
    registerMany: (contributions: PluginContribution[]) => () => void
    onDispose: (cleanup: () => void) => void
  }

  export interface HermesPlugin {
    id: string
    name?: string
    description?: string
    defaultEnabled?: boolean
    register: (context: PluginContext) => void
  }

  export interface RouteContribution {
    path: string
  }

  export interface SidebarNavContribution {
    codicon: string
    label: string
    path: string
  }

  export interface PaletteContribution {
    id: string
    action?: string
    label: string
    keywords?: string[]
    run: () => void
  }

  export const ROUTES_AREA: string
  export const SIDEBAR_NAV_AREA: string
  export const PALETTE_AREA: string
  export const host: {
    navigate(path: string): void
  }
}
