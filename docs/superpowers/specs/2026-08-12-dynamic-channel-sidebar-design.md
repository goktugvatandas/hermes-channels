# Dynamic Channel Sidebar Design

## Purpose

Hermes Crew channels should be reachable from Hermes Desktop's own sidebar. The
plugin will dynamically add one native sidebar row per Crew channel and show an
unread count in that row when new agent messages arrive.

Hermes Desktop 0.20.0 only accepts flat `sidebar.nav` contributions containing
`codicon`, `label`, and `path`. It does not expose parent/child or collapsible
plugin navigation. The channel rows will therefore be ordered immediately after
the main Crew row and use channel-style labels, but they will not be a true
collapsible tree.

## User Experience

The native sidebar will read like:

```text
Crew
# general (3)
# development
# research (1)
```

- The `Crew` row opens `/crew`.
- A channel row opens a dedicated route for that channel.
- Creating a channel adds its row immediately without restarting Desktop.
- Renaming a channel updates its row.
- Deleting a channel removes its row and route.
- New agent messages, including thread replies, increment that channel's count.
- User-authored messages and activity events do not increment unread counts.
- A channel's count resets when its channel view becomes visible.
- Messages arriving while that channel is visible are rendered but are not
  counted as unread.
- Counts persist across Desktop restarts and are rendered as exact integers.

## Architecture

### Channel navigation controller

Add a `ChannelNavigationController` owned by the plugin registration lifecycle.
It is a non-React coordinator with four responsibilities:

1. Reconcile the current channel list with dynamic route and sidebar
   contributions.
2. Track the channel currently visible in a mounted Crew page.
3. Consume persisted Crew events exactly once and update unread counts.
4. Persist unread counts and the last processed event sequence in plugin-scoped
   storage.

The controller depends only on a small interface containing Crew API methods,
plugin contribution registration, plugin storage, and the plugin event socket.
This keeps registration, persistence, and event behavior testable without
rendering the full Desktop shell.

### Dynamic contributions

For each channel, the controller registers:

- a `ROUTES_AREA` contribution at `/crew/channel/{channelId}` that renders
  `CrewPage` with that channel selected;
- a `SIDEBAR_NAV_AREA` contribution immediately after the main Crew row, labeled
  `# {channelName}` or `# {channelName} ({unreadCount})`.

The controller retains the disposer returned for every dynamic contribution.
When a channel changes or its unread count changes, it disposes and re-registers
only the affected sidebar row. When a channel disappears, it disposes both its
row and route. Plugin unload disposes the controller, its timers, socket, and all
dynamic contributions.

Channel order follows the API's channel order. Contribution orders are assigned
from a stable range immediately after the Crew row. The controller reconciles
channels at startup and every ten seconds, with at most one reconciliation in
flight. Page-originated creates and renames notify it immediately rather than
waiting for that fallback interval.

### Page integration

`CrewPage` gains explicit integration points instead of importing global
controller state:

- `initialChannelId` selects the channel represented by a dynamic route;
- `onChannelViewed(channelId | null)` marks a visible channel read and clears
  the active channel when the view unmounts or switches to Search or Studio;
- `onChannelCreated(channel)` registers a new channel immediately and navigates
  to its dedicated route;
- channel selection navigates to the channel's dedicated route so Hermes's
  native active-row styling remains correct.

Opening `/crew` remains valid and shows the existing Crew page. If a channel
route points to a channel that was removed before reconciliation, the page falls
back to `/crew` rather than rendering a dead channel.

## Unread State and Event Flow

The plugin-scoped persisted state is versioned and contains:

```ts
interface ChannelNavigationState {
  version: 1
  lastEventSequence: number
  unreadByChannel: Record<string, number>
}
```

On first use, the controller reads the current event journal and seeds
`lastEventSequence` without counting historical messages. This prevents all old
channel history from appearing unread after upgrading.

After bootstrap:

1. The plugin socket accelerates new event delivery.
2. A two-second, single-flight polling fallback calls
   `/events?after={lastEventSequence}`.
3. Events at or below the stored sequence are ignored, preventing socket/poll
   duplicates.
4. A `completed` event with an agent result `messageId` increments the channel
   unless that channel is currently visible.
5. The sequence and unread state are persisted after each processed batch.
6. Opening the channel sets its count to zero and immediately updates its row.

The existing channel message refresh remains the source of truth for rendering
the actual response. The navigation controller tracks only notification state;
it does not cache message content.

## Failure Handling

- If initial channel discovery fails, the static Crew row remains usable and the
  controller retries without crashing the plugin page.
- If the event socket is unavailable, polling continues.
- If polling fails, the next interval resumes from the persisted sequence.
- Malformed or unrelated events advance only when they contain a valid numeric
  sequence and never create unread counts.
- Unread state for deleted channels is removed during reconciliation.
- A failure to update one dynamic contribution does not unregister other
  channels.

## Testing

### Controller tests

- Initial channels register ordered route and sidebar contributions.
- New, renamed, and deleted channels reconcile without a Desktop restart.
- A completed agent result increments the correct inactive channel.
- Thread replies use the same channel count.
- User messages, activity events, malformed events, and duplicate sequences do
  not increment counts.
- The visible channel does not accumulate unread messages.
- Opening a channel resets and persists its count.
- Persisted counts and the event cursor survive controller recreation.
- First-run bootstrap does not mark historical completions unread.
- Socket and polling delivery of the same event is idempotent.
- Disposal removes dynamic contributions and background work.

### UI tests

- A channel route selects the correct channel.
- Clicking an internal channel row navigates to its dedicated route.
- Opening Search or Studio clears the visible-channel marker.
- Creating a channel registers it and navigates to its route.
- Completed turns still refresh and render their persisted agent messages.

### Release verification

Run the full Python and TypeScript suites, typecheck, build, Hermes 0.20.0
runtime-import verification, release packaging, install into the local Hermes
home, and verify the installed bundle hash.

## Non-Goals

- Modifying or rebuilding Hermes Desktop core to add true nested/collapsible
  plugin navigation.
- Per-thread unread badges.
- Mentions-only notification preferences.
- Synchronizing read state between multiple machines or users.
- Replacing Hermes's native sidebar styling.
