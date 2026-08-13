import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  ROUTES_AREA,
  type RouteContribution,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
} from '@hermes/plugin-sdk'

import desktopStyles from 'virtual:crew-desktop-css'

import { CrewApi } from './api'
import { ChannelNavigationController, channelPath } from './channel-navigation'
import { GatewayWorker } from './gateway-worker'
import { CrewPage, type CrewView } from './views/crew-page'

const STYLE_ELEMENT_ID = 'hermes-crew-desktop-styles'

function injectStyles(onDispose: (cleanup: () => void) => void): void {
  if (typeof document === 'undefined') return
  document.getElementById(STYLE_ELEMENT_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = desktopStyles
  document.head.append(style)
  onDispose(() => style.remove())
}

const plugin: HermesPlugin = {
  id: 'hermes-crew',
  name: 'Hermes Crew',
  description: 'Persistent Hermes profiles working together in local channels.',
  defaultEnabled: false,
  register(ctx) {
    injectStyles(ctx.onDispose)
    const api = new CrewApi(ctx.rest)
    let navigation!: ChannelNavigationController
    const renderCrewPage = (initialChannelId?: string, initialView?: CrewView) => (
      <div className="hermes-crew-desktop">
        <CrewPage
          api={api}
          initialChannelId={initialChannelId}
          initialView={initialView}
          onChannelCreated={(channel) => navigation.upsertChannel(channel)}
          onChannelViewed={(channelId) => navigation.setViewedChannel(channelId)}
          onNavigateChannel={(channelId) => host.navigate(
            channelId ? channelPath(channelId) : '/crew',
          )}
        />
      </div>
    )
    const worker = new GatewayWorker({ rest: ctx.rest, socket: ctx.socket })
    ctx.onDispose(worker.start())
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/crew' } satisfies RouteContribution,
        render: () => renderCrewPage(),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: {
          codicon: 'organization',
          label: 'Crew',
          path: '/crew',
        } satisfies SidebarNavContribution,
      },
      {
        id: 'workshop-page',
        area: ROUTES_AREA,
        data: { path: '/crew/agent-lab' } satisfies RouteContribution,
        render: () => renderCrewPage(undefined, 'workshop'),
      },
      {
        id: 'workshop-nav',
        area: SIDEBAR_NAV_AREA,
        // Below the dynamic channel entries (which start at 56).
        order: 400,
        data: {
          codicon: 'beaker',
          label: 'Agent Lab',
          path: '/crew/agent-lab',
        } satisfies SidebarNavContribution,
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-crew.open',
          label: 'Open Hermes Crew',
          keywords: ['crew', 'agents', 'channels', 'team'],
          run: () => host.navigate('/crew'),
        } satisfies PaletteContribution,
      },
      {
        id: 'open-workshop',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-crew.open-workshop',
          label: 'Open Agent Lab',
          keywords: ['crew', 'lab', 'workshop', 'agents', 'profiles', 'soul'],
          run: () => host.navigate('/crew/agent-lab'),
        } satisfies PaletteContribution,
      },
    ])

    navigation = new ChannelNavigationController({
      api,
      register: ctx.register,
      renderChannel: (channelId) => renderCrewPage(channelId),
      socket: ctx.socket,
      storage: ctx.storage,
    })
    ctx.onDispose(navigation.start())
  },
}

export default plugin
