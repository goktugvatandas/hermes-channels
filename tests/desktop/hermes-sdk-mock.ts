export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'

export const ModelCatalogMenu = () => null

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
