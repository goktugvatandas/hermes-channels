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

import { CrewApi } from './api'
import { ChannelNavigationController, channelPath } from './channel-navigation'
import { GatewayWorker } from './gateway-worker'
import { CrewPage } from './views/crew-page'

const plugin: HermesPlugin = {
  id: 'hermes-crew',
  name: 'Hermes Crew',
  description: 'Persistent Hermes profiles working together in local channels.',
  defaultEnabled: false,
  register(ctx) {
    const api = new CrewApi(ctx.rest)
    let navigation!: ChannelNavigationController
    const renderCrewPage = (initialChannelId?: string) => (
      <CrewPage
        api={api}
        initialChannelId={initialChannelId}
        onChannelCreated={(channel) => navigation.upsertChannel(channel)}
        onChannelViewed={(channelId) => navigation.setViewedChannel(channelId)}
        onNavigateChannel={(channelId) => host.navigate(
          channelId ? channelPath(channelId) : '/crew',
        )}
      />
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
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-crew.open',
          label: 'Open Hermes Crew',
          keywords: ['crew', 'agents', 'channels', 'team'],
          run: () => host.navigate('/crew'),
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
