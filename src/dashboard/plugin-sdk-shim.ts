import type { Context, ReactElement, ReactNode } from 'react'

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

type ContextPoint = { x: number; y: number } | null
const ContextMenuState = React.createContext<{
  point: ContextPoint
  setPoint(point: ContextPoint): void
}>({ point: null, setPoint: noop })

export function ContextMenu({ children }: { children?: ReactNode }) {
  const [point, setPoint] = React.useState<ContextPoint>(null)
  return React.createElement(ContextMenuState.Provider, { value: { point, setPoint } }, children)
}

export function ContextMenuTrigger({ children }: { asChild?: boolean; children?: ReactNode }) {
  const { setPoint } = React.useContext(ContextMenuState)
  if (!React.isValidElement(children)) return children || null
  const child = children as ReactElement<Record<string, unknown>>
  const previous = child.props.onContextMenu as ((event: import('react').MouseEvent) => void) | undefined
  return React.cloneElement(child, {
    onContextMenu: (event: import('react').MouseEvent) => {
      previous?.(event)
      event.preventDefault()
      setPoint({ x: event.clientX, y: event.clientY })
    },
  })
}

export function ContextMenuContent({ children, className }: { children?: ReactNode; className?: string }) {
  const { point, setPoint } = React.useContext(ContextMenuState)
  if (!point) return null
  return React.createElement('div', {
    className,
    onMouseLeave: () => setPoint(null),
    role: 'menu',
    style: { left: point.x, position: 'fixed', top: point.y, zIndex: 1000 },
  }, children)
}

export function ContextMenuItem({ children, className, style, onSelect }: {
  children?: ReactNode
  className?: string
  style?: import('react').CSSProperties
  onSelect?(event: Event): void
}) {
  const { setPoint } = React.useContext(ContextMenuState)
  return React.createElement('button', {
    className,
    onClick: () => {
      onSelect?.(new Event('select'))
      setPoint(null)
    },
    role: 'menuitem',
    style,
    type: 'button',
  }, children)
}

export function ContextMenuSeparator({ className }: { className?: string }) {
  return React.createElement('div', { className, role: 'separator' })
}

const DialogState = React.createContext<{
  open: boolean
  setOpen(open: boolean): void
}>({ open: false, setOpen: noop })

export function Dialog({ open = false, onOpenChange, children }: {
  open?: boolean
  onOpenChange?(open: boolean): void
  children?: ReactNode
}) {
  return React.createElement(DialogState.Provider, {
    value: { open, setOpen: (next) => onOpenChange?.(next) },
  }, children)
}

export function DialogContent({ children, className }: { children?: ReactNode; className?: string }) {
  const { open, setOpen } = React.useContext(DialogState)
  if (!open) return null
  return React.createElement('div', {
    onMouseDown: (event: import('react').MouseEvent) => {
      if (event.target === event.currentTarget) setOpen(false)
    },
    style: {
      alignItems: 'center', background: 'rgb(0 0 0 / 45%)', display: 'flex',
      inset: 0, justifyContent: 'center', position: 'fixed', zIndex: 1000,
    },
  }, React.createElement('div', { className }, children))
}

export function DialogHeader({ children, className }: { children?: ReactNode; className?: string }) {
  return React.createElement('div', { className }, children)
}

export function DialogTitle({ children, className }: { children?: ReactNode; className?: string }) {
  return React.createElement('h2', { className }, children)
}

interface SelectOption {
  disabled?: boolean
  label: ReactNode
  value: string
}

function selectParts(children: ReactNode): {
  ariaLabel?: string
  className?: string
  options: SelectOption[]
} {
  const result: { ariaLabel?: string; className?: string; options: SelectOption[] } = { options: [] }
  const visit = (nodes: ReactNode) => React.Children.forEach(nodes, (node) => {
    if (!React.isValidElement(node)) return
    const element = node as ReactElement<Record<string, unknown>>
    if (element.type === SelectTrigger) {
      result.ariaLabel = element.props['aria-label'] as string | undefined
      result.className = element.props.className as string | undefined
    } else if (element.type === SelectItem) {
      result.options.push({
        disabled: element.props.disabled as boolean | undefined,
        label: element.props.children as ReactNode,
        value: element.props.value as string,
      })
    }
    visit(element.props.children as ReactNode)
  })
  visit(children)
  return result
}

export function Select({ value, onValueChange, disabled, children }: {
  value?: string
  onValueChange?(value: string): void
  disabled?: boolean
  children?: ReactNode
}) {
  const parts = selectParts(children)
  return React.createElement('select', {
    'aria-label': parts.ariaLabel,
    className: parts.className,
    disabled,
    onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => onValueChange?.(event.target.value),
    value,
  }, parts.options.map((option) => React.createElement('option', {
    disabled: option.disabled,
    key: option.value,
    value: option.value,
  }, option.label)))
}

export function SelectTrigger(_props: { children?: ReactNode; className?: string; 'aria-label'?: string }) {
  return null
}
export function SelectValue(_props: { placeholder?: string }) { return null }
export function SelectContent(_props: { children?: ReactNode; className?: string }) { return null }
export function SelectItem(_props: { value: string; children?: ReactNode; className?: string; disabled?: boolean }) {
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
