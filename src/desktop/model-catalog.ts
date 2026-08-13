import { host } from '@hermes/plugin-sdk'

import { isDashboardHost } from './session-nav'

export interface CatalogModel {
  provider: string
  providerName: string
  model: string
  reasoning: boolean
  fast: boolean
}

interface ModelOptionProvider {
  slug: string
  name: string
  models?: string[]
  authenticated?: boolean
  capabilities?: Record<string, { fast: boolean; reasoning: boolean }>
}

interface ModelOptionsResponse {
  model?: string
  provider?: string
  providers?: ModelOptionProvider[]
}

async function fetchOptions(): Promise<ModelOptionsResponse> {
  if (isDashboardHost()) {
    // The dashboard shim's host.request always rejects; the catalog endpoint
    // is on the same origin behind the host's authenticated fetch.
    return window.__HERMES_PLUGIN_SDK__.fetchJSON<ModelOptionsResponse>(
      '/api/model/options?explicit_only=1',
    )
  }
  return host.request<ModelOptionsResponse>('model.options', { explicit_only: true })
}

/**
 * Flatten the Hermes model catalog into dropdown rows: configured providers
 * only, without the virtual `moa` aggregator. Returns [] when the catalog is
 * unreachable (gateway down) so editors can fall back to free-form input.
 */
export async function fetchModelCatalog(): Promise<CatalogModel[]> {
  try {
    const options = await fetchOptions()
    return (options.providers ?? [])
      .filter((provider) => provider.slug.toLowerCase() !== 'moa' && provider.authenticated !== false)
      .flatMap((provider) => (provider.models ?? []).map((model) => ({
        provider: provider.slug,
        providerName: provider.name || provider.slug,
        model,
        reasoning: provider.capabilities?.[model]?.reasoning ?? true,
        fast: provider.capabilities?.[model]?.fast ?? false,
      })))
  } catch {
    return []
  }
}

export function catalogProviders(catalog: CatalogModel[]): Array<{ slug: string; name: string }> {
  const seen = new Map<string, string>()
  for (const entry of catalog) {
    if (!seen.has(entry.provider)) seen.set(entry.provider, entry.providerName)
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }))
}
