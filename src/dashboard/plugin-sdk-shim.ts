import type { Context, ReactNode } from 'react'

const SDK = window.__HERMES_PLUGIN_SDK__
const React = SDK.React

export interface RuntimeReadinessResult {
  checksDisagree: boolean
  ready: boolean
  reason: string | null
  source: 'fallback' | 'runtime_check' | 'setup_status'
}

export interface PluginRestOptions {
  body?: unknown
  method?: string
  timeoutMs?: number
}

export type PluginRest = <T>(path: string, options?: PluginRestOptions) => Promise<T>

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
  select(model: string, provider: string): Promise<boolean | void> | boolean | void
  setOptions(patch: { effort?: string; fast?: boolean }, row: { isActive: boolean; model: string; provider: string }): void
}

const noop: () => void = () => {}
export const ModelMenuCloseContext: Context<() => void> = React.createContext(noop)

export function DropdownMenu({ children }: { children?: ReactNode }) {
  return React.createElement(React.Fragment, null, React.Children.toArray(children)[0] || null)
}

export function DropdownMenuTrigger({ children }: { asChild?: boolean; children?: ReactNode }) {
  if (!React.isValidElement(children)) return children || null
  return React.cloneElement(children as import('react').ReactElement<Record<string, unknown>>, {
    onClick: () => host.navigate('/models'),
  })
}

export function DropdownMenuContent() {
  return null
}

export function ModelCatalogMenu() {
  return null
}

export const host = {
  navigate(path: string) {
    const dashboardPath = path === '/settings' ? '/config' : path === '/projects' ? '/files' : path
    window.history.pushState({}, '', dashboardPath)
    window.dispatchEvent(new PopStateEvent('popstate'))
  },
  onEvent() {
    return () => undefined
  },
  request<T>(): Promise<T> {
    return Promise.reject(new Error('Gateway requests are not exposed by the dashboard plugin runtime.'))
  },
  state: {
    gateway: {
      get: () => 'open',
    },
  },
}

export async function evaluateRuntimeReadiness(): Promise<RuntimeReadinessResult> {
  return { checksDisagree: false, ready: true, reason: null, source: 'fallback' }
}
