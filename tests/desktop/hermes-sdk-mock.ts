import {
  createContext,
  createElement,
  useContext,
  type PropsWithChildren,
  type ReactElement,
}
from 'react'

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'

const HermesMenuContext = createContext(false)

export function DropdownMenu({ children }: PropsWithChildren): ReactElement {
  return createElement(HermesMenuContext.Provider, { value: true }, children)
}

export function DropdownMenuContent({ children }: PropsWithChildren): ReactElement {
  return createElement('div', null, children)
}

export function DropdownMenuTrigger({ children }: PropsWithChildren): ReactElement {
  return createElement('div', null, children)
}

export const ModelMenuCloseContext = createContext<() => void>(() => undefined)

export function ModelCatalogMenu(): ReactElement {
  if (!useContext(HermesMenuContext)) {
    throw new Error('ModelCatalogMenu must be used within DropdownMenu')
  }
  return createElement('div', { 'aria-label': 'Hermes model catalog' })
}

export const evaluateRuntimeReadiness = async () => ({
  checksDisagree: false,
  ready: true,
  reason: null,
  source: 'runtime_check' as const,
})

export const host = {
  navigate: (_path: string) => undefined,
  onEvent: (_type: string, _listener: (event: unknown) => void) =>
    () => undefined,
  request: async <T,>(
    _method: string,
    _params: Record<string, unknown> = {},
  ): Promise<T> => ({}) as T,
  state: {
    gateway: {
      get: () => 'idle',
    },
  },
}

// ── Select primitives: rendered as a NATIVE select so tests keep using
// getByLabelText + fireEvent.change. Trigger/Content/Item act as markers the
// Select root walks to collect the aria-label and options. ──
import { Children, isValidElement } from 'react'

export function SelectTrigger(_props: Record<string, unknown>): null { return null }
export function SelectContent(_props: Record<string, unknown>): null { return null }
export function SelectItem(_props: Record<string, unknown>): null { return null }
export function SelectValue(_props: Record<string, unknown>): null { return null }

export function Select({ value, onValueChange, children }: {
  value?: string
  onValueChange?(next: string): void
  children?: unknown
}): ReactElement {
  const items: Array<{ value: string; label: unknown }> = []
  let label: string | undefined
  const walk = (node: unknown): void => {
    Children.forEach(node as Parameters<typeof Children.forEach>[0], (child) => {
      if (!isValidElement(child)) return
      const element = child as ReactElement & { type: unknown }
      const props = element.props as Record<string, unknown>
      if (element.type === SelectTrigger) {
        if (typeof props['aria-label'] === 'string') label = props['aria-label']
        walk(props.children)
      } else if (element.type === SelectContent) {
        walk(props.children)
      } else if (element.type === SelectItem) {
        items.push({ value: String(props.value), label: props.children })
      } else if (props?.children) {
        walk(props.children)
      }
    })
  }
  walk(children)
  return createElement(
    'select',
    {
      'aria-label': label,
      onChange: (event: { target: { value: string } }) => onValueChange?.(event.target.value),
      value,
    },
    items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label as never)),
  )
}

// ── Context menu / dialog primitives: plain passthroughs. Tests that need
// menu behaviour assert on the trigger content; the menu body renders inline
// so its items stay reachable by text. ──
function passthrough(name: string) {
  const component = ({ children }: PropsWithChildren): ReactElement =>
    createElement('div', { 'data-sdk': name }, children)
  component.displayName = name
  return component
}

export const ContextMenu = passthrough('ContextMenu')
export const ContextMenuTrigger = passthrough('ContextMenuTrigger')
export const ContextMenuContent = passthrough('ContextMenuContent')
export function ContextMenuItem({ children, onSelect }: PropsWithChildren<{ onSelect?(): void }>): ReactElement {
  return createElement('button', { onClick: onSelect, type: 'button' }, children)
}
export function Dialog({ children, open }: PropsWithChildren<{ open?: boolean }>): ReactElement | null {
  return open === false ? null : createElement('div', { 'data-sdk': 'Dialog', role: 'dialog' }, children)
}
export const DialogContent = passthrough('DialogContent')
export const DialogHeader = passthrough('DialogHeader')
export const DialogTitle = passthrough('DialogTitle')
