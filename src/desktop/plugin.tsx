import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  ROUTES_AREA,
  type RouteContribution,
} from '@hermes/plugin-sdk'

import desktopStyles from 'virtual:channels-desktop-css'

import { CrewApi } from './api'
import { ChannelNavigationController, channelPath } from './channel-navigation'
import { CrewPane, PaneUnreadDot } from './components/crew-pane'
import { GatewayWorker } from './gateway-worker'
import { installAetherTheme } from './aether-theme'
import { CrewPage, type CrewView } from './views/crew-page'

const STYLE_ELEMENT_ID = 'hermes-channels-desktop-styles'

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
  id: 'hermes-channels',
  name: 'Hermes Channels',
  description: 'Slack-style channels where persistent Hermes bots work together.',
  defaultEnabled: false,
  register(ctx) {
    injectStyles(ctx.onDispose)
    installAetherTheme()
    const api = new CrewApi(ctx.rest)
    let navigation!: ChannelNavigationController
    const renderChannelsPage = (initialChannelId?: string, initialView?: CrewView) => (
      <div className="hermes-channels-desktop">
        <CrewPage
          api={api}
          initialChannelId={initialChannelId}
          initialView={initialView}
          onChannelCreated={(channel) => navigation.upsertChannel(channel)}
          onChannelViewed={(channelId) => navigation.setViewedChannel(channelId)}
          onNavigateChannel={(channelId) => host.navigate(
            channelId ? channelPath(channelId) : '/channels',
          )}
          onNavigateView={(view) => host.navigate(
            view === 'home' ? '/channels'
              : view === 'workshop' ? '/channels/bot-management'
                : view === 'profile' ? '/channels/profile'
                  : view === 'search' ? '/channels/search'
                    : '/channels/settings',
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
        data: { path: '/channels' } satisfies RouteContribution,
        render: () => renderChannelsPage(),
      },
      {
        id: 'bot-management-page',
        area: ROUTES_AREA,
        data: { path: '/channels/bot-management' } satisfies RouteContribution,
        render: () => renderChannelsPage(undefined, 'workshop'),
      },
      {
        id: 'profile-page',
        area: ROUTES_AREA,
        data: { path: '/channels/profile' } satisfies RouteContribution,
        render: () => renderChannelsPage(undefined, 'profile'),
      },
      {
        id: 'settings-page',
        area: ROUTES_AREA,
        data: { path: '/channels/settings' } satisfies RouteContribution,
        render: () => renderChannelsPage(undefined, 'settings'),
      },
      {
        id: 'search-page',
        area: ROUTES_AREA,
        data: { path: '/channels/search' } satisfies RouteContribution,
        render: () => renderChannelsPage(undefined, 'search'),
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-channels.open',
          label: 'Open Hermes Channels',
          keywords: ['channels', 'bots', 'team', 'chat'],
          run: () => host.navigate('/channels'),
        } satisfies PaletteContribution,
      },
      {
        id: 'open-bot-management',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-channels.open-bot-management',
          label: 'Open Bot Management',
          keywords: ['channels', 'bots', 'profiles', 'soul', 'automation'],
          run: () => host.navigate('/channels/bot-management'),
        } satisfies PaletteContribution,
      },
    ])

    navigation = new ChannelNavigationController({
      api,
      register: ctx.register,
      renderChannel: (channelId) => renderChannelsPage(channelId),
      socket: ctx.socket,
      storage: ctx.storage,
    })

    // The CHANNELS tab: a left pane beside SESSIONS (and BOTS), the same
    // mechanism Bot Mode uses. This is the plugin's one navigation surface.
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Channels',
      data: {
        placement: 'left',
        width: '280px',
        collapsible: true,
        // Live unread dot on the CHANNELS tab itself.
        tabLead: () => <PaneUnreadDot controller={navigation} />,
      },
      render: () => (
        <div className="hermes-channels-desktop h-full min-h-0">
          <CrewPane api={api} controller={navigation} />
        </div>
      ),
    })

    ctx.onDispose(navigation.start())
  },
}

export default plugin
