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
