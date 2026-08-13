declare module '@hermes/plugin-sdk' {
  import type { Context, ReactNode } from 'react'

  export interface ModelChoice {
    effort: string
    fast: boolean
    model: string
    provider: string
  }

  export interface ModelMenuController {
    applyPreset(preset: { effort?: string; fast?: boolean }, row: { model: string; provider: string }): void
    current: ModelChoice
    presetFor(provider: string, model: string): { effort?: string; fast?: boolean }
    select(model: string, provider: string): Promise<boolean | void> | void
    setOptions(patch: { effort?: string; fast?: boolean }, row: { isActive: boolean; model: string; provider: string }): void
  }

  export interface RuntimeReadinessResult {
    checksDisagree: boolean
    ready: boolean
    reason: string | null
    source: 'fallback' | 'runtime_check' | 'setup_status'
  }

  export interface PluginRestOptions {
    method?: string
    body?: unknown
    timeoutMs?: number
  }

  export type PluginRest = <T>(
    path: string,
    options?: PluginRestOptions,
  ) => Promise<T>

  export interface PluginStorage {
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
    remove(key: string): void
  }

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
    register: (contribution: PluginContribution) => () => void
    registerMany: (contributions: PluginContribution[]) => () => void
    onDispose: (cleanup: () => void) => void
    storage: PluginStorage
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
  export function DropdownMenu(props: {
    children?: ReactNode
    onOpenChange?(open: boolean): void
    open?: boolean
  }): ReactNode
  export function DropdownMenuContent(props: {
    align?: 'start' | 'center' | 'end'
    children?: ReactNode
    className?: string
  }): ReactNode
  export function DropdownMenuTrigger(props: {
    asChild?: boolean
    children?: ReactNode
  }): ReactNode
  export function ModelCatalogMenu(props: { controller: ModelMenuController; profile?: string }): ReactNode
  export const ModelMenuCloseContext: Context<() => void>
  export function evaluateRuntimeReadiness(
    request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
    options?: { requestedProvider?: string },
  ): Promise<RuntimeReadinessResult>
  export const host: {
    navigate(path: string): void
    onEvent(type: string, listener: (event: {
      type: string
      session_id?: string
      profile?: string
      payload?: unknown
    }) => void): () => void
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>
    state: {
      gateway: {
        get(): string
      }
    }
  }
}
