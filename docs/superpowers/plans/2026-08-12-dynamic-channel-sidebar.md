# Dynamic Channel Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live Crew channel rows to Hermes Desktop's native sidebar, with persisted per-channel unread counts that clear when a channel is viewed.

**Architecture:** A plugin-owned `ChannelNavigationController` reconciles Crew channels into dynamic route and `sidebar.nav` contributions. It processes the persisted event journal through socket plus single-flight polling, stores an idempotent event cursor and unread map in Hermes plugin storage, and exposes small callbacks to `CrewPage` for visibility and navigation.

**Tech Stack:** React 19, TypeScript 6, Hermes Desktop plugin SDK 0.17.0, Hermes Agent 0.20.0, Vitest/jsdom, esbuild ESM bundle.

## Global Constraints

- Hermes Desktop SDK compatibility is exactly `0.17.0`.
- Hermes Agent compatibility is exactly `0.20.0`.
- Runtime bundles may import only `@hermes/plugin-sdk`, `react`, and Hermes-allowed React JSX runtimes.
- Hermes 0.20.0 plugin sidebar contributions are flat; do not patch Hermes core or emulate unsupported collapsible children.
- Native channel rows must be dynamic and ordered immediately after the static Crew row.
- Labels are exactly `# {channelName}` at zero unread and `# {channelName} ({count})` above zero.
- Only completed agent result messages increment unread counts; user messages and activity-only events do not.
- Agent thread replies count against their containing channel.
- A visible channel never accumulates unread messages, and opening a channel resets its count.
- Unread counts and the last processed event sequence persist across Desktop restarts.
- Existing Crew data under `~/.hermes/crew` must survive installation.
- Use test-driven development: each production change follows a witnessed failing test.

---

## File Structure

- Create `src/desktop/channel-navigation.tsx`: dynamic contribution controller, path/label helpers, persisted unread state, socket/poll lifecycle.
- Create `tests/desktop/channel-navigation.test.tsx`: controller reconciliation, persistence, event idempotency, visibility, and disposal tests.
- Modify `src/desktop/sdk.d.ts`: declare the real Hermes 0.17 plugin `register` and `storage` interfaces used by the controller.
- Modify `src/desktop/plugin.tsx`: construct and start the controller; render static and dynamic Crew routes through one page factory.
- Modify `tests/desktop/plugin.test.tsx`: verify static registration plus controller lifecycle wiring.
- Modify `src/desktop/views/crew-page.tsx`: accept route selection and navigation lifecycle callbacks.
- Modify `tests/desktop/channel-flow.test.tsx`: verify dedicated-route selection, visibility, root navigation, creation, and missing-channel fallback.
- Modify `CHANGELOG.md`: record native dynamic navigation, unread semantics, final test counts, and release hashes.

---

### Task 1: Declare the Hermes Plugin Lifecycle Contract

**Files:**
- Modify: `src/desktop/sdk.d.ts`
- Test: `tests/desktop/channel-navigation.test.tsx`

**Interfaces:**
- Consumes: Hermes 0.17's runtime `PluginContext.register`, `PluginContext.storage`, and `PluginContribution` contract.
- Produces: `PluginStorage`, complete `PluginContext`, and a testable in-memory implementation for later controller tasks.

- [ ] **Step 1: Write the failing SDK contract test**

Create `tests/desktop/channel-navigation.test.tsx` with a compile-time and runtime storage fixture:

```tsx
import type { PluginContext, PluginStorage } from '@hermes/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'

function memoryStorage(seed: Record<string, unknown> = {}): PluginStorage {
  const values = new Map(Object.entries(seed))
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) as never : fallback,
    set: (key, value) => { values.set(key, value) },
    remove: (key) => { values.delete(key) },
  }
}

describe('channel navigation SDK contract', () => {
  it('supports dynamic registration and plugin-scoped persistence', () => {
    const storage = memoryStorage()
    const unregister = vi.fn()
    const context = {
      register: vi.fn(() => unregister),
      storage,
    } satisfies Pick<PluginContext, 'register' | 'storage'>

    context.storage.set('navigation', { unread: 2 })

    expect(context.storage.get('navigation', null)).toEqual({ unread: 2 })
    expect(context.register({ id: 'channel-a', area: 'sidebar.nav' })).toBe(unregister)
  })
})
```

- [ ] **Step 2: Run the test and typecheck to verify the contract is missing**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: TypeScript fails because `PluginStorage`, `PluginContext.register`, and `PluginContext.storage` are not declared.

- [ ] **Step 3: Add the exact SDK declarations**

Extend `src/desktop/sdk.d.ts`:

```ts
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  remove(key: string): void
}

export interface PluginContext {
  rest: PluginRest
  socket: (path: string, onMessage: (data: unknown) => void) => () => void
  register: (contribution: PluginContribution) => () => void
  registerMany: (contributions: PluginContribution[]) => () => void
  onDispose: (cleanup: () => void) => void
  storage: PluginStorage
}
```

Keep the existing fields unchanged. `PluginStorage` and `PluginContext` are
type-only imports in the tests, so the runtime SDK mock needs no new export.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: the contract test passes and typecheck exits zero.

- [ ] **Step 5: Commit the SDK contract**

```bash
git add src/desktop/sdk.d.ts tests/desktop/channel-navigation.test.tsx
git commit -m "test: declare dynamic plugin navigation contract"
```

---

### Task 2: Reconcile Channels into Native Routes and Sidebar Rows

**Files:**
- Create: `src/desktop/channel-navigation.tsx`
- Modify: `tests/desktop/channel-navigation.test.tsx`

**Interfaces:**
- Consumes: `CrewApi.listChannels(): Promise<CrewChannel[]>`, `PluginContext.register`, `ROUTES_AREA`, `SIDEBAR_NAV_AREA`.
- Produces:
  - `channelPath(channelId: string): string`
  - `channelLabel(name: string, unread: number): string`
  - `ChannelNavigationController.reconcile(channels?: CrewChannel[]): Promise<void>`
  - `ChannelNavigationController.upsertChannel(channel: CrewChannel): void`
  - `ChannelNavigationController.dispose(): void`

- [ ] **Step 1: Add failing reconciliation tests**

Extend `tests/desktop/channel-navigation.test.tsx` with complete channel fixtures and a registration harness:

```tsx
import { ROUTES_AREA, SIDEBAR_NAV_AREA, type PluginContribution } from '@hermes/plugin-sdk'
import type { CrewApi } from '../../src/desktop/api'
import { ChannelNavigationController, channelLabel, channelPath } from '../../src/desktop/channel-navigation'
import type { CrewChannel } from '../../src/desktop/types'

const general: CrewChannel = {
  id: 'general-id', name: 'general', purpose: '', topic: '',
  defaultResponderProfile: null, defaultProject: null, allowedProjects: [],
  routingRules: {}, createdAt: 1, updatedAt: 1,
}
const research: CrewChannel = { ...general, id: 'research-id', name: 'research', createdAt: 2, updatedAt: 2 }

function registrationHarness() {
  const live = new Map<string, PluginContribution>()
  const register = vi.fn((item: PluginContribution) => {
    live.set(item.id, item)
    return () => { live.delete(item.id) }
  })
  return { live, register }
}

it('registers ordered native routes and sidebar rows for current channels', async () => {
  const { live, register } = registrationHarness()
  const controller = new ChannelNavigationController({
    api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
    register,
    storage: memoryStorage(),
    socket: vi.fn(() => vi.fn()),
    renderChannel: (id) => <div data-channel={id} />,
  })

  await controller.reconcile()

  expect(channelPath('general/id')).toBe('/crew/channel/general%2Fid')
  expect(channelLabel('general', 0)).toBe('# general')
  expect([...live.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: ROUTES_AREA, data: { path: '/crew/channel/general-id' } }),
    expect.objectContaining({ area: SIDEBAR_NAV_AREA, order: 56, data: { codicon: 'comment-discussion', label: '# general', path: '/crew/channel/general-id' } }),
    expect.objectContaining({ area: SIDEBAR_NAV_AREA, order: 57, data: { codicon: 'comment-discussion', label: '# research', path: '/crew/channel/research-id' } }),
  ]))
})

it('updates renamed channels and disposes deleted channel contributions', async () => {
  const { live, register } = registrationHarness()
  const api = { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi
  const controller = new ChannelNavigationController({
    api, register, storage: memoryStorage(), socket: vi.fn(() => vi.fn()),
    renderChannel: (id) => <div data-channel={id} />,
  })
  await controller.reconcile()

  await controller.reconcile([{ ...general, name: 'lobby', updatedAt: 3 }])

  expect([...live.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: SIDEBAR_NAV_AREA, data: expect.objectContaining({ label: '# lobby' }) }),
  ]))
  expect([...live.values()].some((item) => item.id.includes('research-id'))).toBe(false)
})
```

Add disposal and isolated-registration-failure tests:

```tsx
it('disposes every dynamic contribution', async () => {
  const { live, register } = registrationHarness()
  const controller = new ChannelNavigationController({
    api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
    register,
    storage: memoryStorage(),
    socket: vi.fn(() => vi.fn()),
    renderChannel: (id) => <div data-channel={id} />,
  })
  await controller.reconcile()

  controller.dispose()

  expect(live.size).toBe(0)
})

it('keeps healthy channels live when one channel registration fails', async () => {
  const { live, register: baseRegister } = registrationHarness()
  const register = vi.fn((item: PluginContribution) => {
    if (item.id.includes('research-id')) throw new Error('broken contribution')
    return baseRegister(item)
  })
  const controller = new ChannelNavigationController({
    api: { listChannels: vi.fn(async () => [general, research]) } as unknown as CrewApi,
    register,
    storage: memoryStorage(),
    socket: vi.fn(() => vi.fn()),
    renderChannel: (id) => <div data-channel={id} />,
  })

  await controller.reconcile()

  expect([...live.keys()]).toEqual(['channel-route-general-id', 'channel-nav-general-id'])
})
```

- [ ] **Step 2: Run the focused tests to verify red**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
```

Expected: FAIL because `src/desktop/channel-navigation.tsx` and its exports do not exist.

- [ ] **Step 3: Implement path, label, and contribution reconciliation**

Create `src/desktop/channel-navigation.tsx` with these public types and initial implementation:

```tsx
import {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type PluginContribution,
  type PluginStorage,
  type SidebarNavContribution,
  type RouteContribution,
} from '@hermes/plugin-sdk'
import type { ReactNode } from 'react'

import type { CrewApi } from './api'
import type { CrewChannel, EventFrame } from './types'

export const NAVIGATION_STORAGE_KEY = 'channel-navigation-v1'
const CHANNEL_ORDER_START = 56

export interface ChannelNavigationState {
  version: 1
  lastEventSequence: number
  unreadByChannel: Record<string, number>
}

interface ChannelNavigationOptions {
  api: Pick<CrewApi, 'events' | 'listChannels'>
  register(contribution: PluginContribution): () => void
  renderChannel(channelId: string): ReactNode
  socket(path: string, onMessage: (data: unknown) => void): () => void
  storage: PluginStorage
  pollIntervalMs?: number
  reconcileIntervalMs?: number
}

interface ChannelRegistration {
  channel: CrewChannel
  order: number
  routeDispose: () => void
  sidebarDispose: () => void
}

export function channelPath(channelId: string): string {
  return `/crew/channel/${encodeURIComponent(channelId)}`
}

export function channelLabel(name: string, unread: number): string {
  return unread > 0 ? `# ${name} (${unread})` : `# ${name}`
}

export class ChannelNavigationController {
  private readonly registrations = new Map<string, ChannelRegistration>()
  private channels: CrewChannel[] = []
  private disposed = false

  constructor(private readonly options: ChannelNavigationOptions) {}

  async reconcile(channels = await this.options.api.listChannels()): Promise<void> {
    if (this.disposed) return
    const nextIds = new Set(channels.map((channel) => channel.id))
    for (const [id, registration] of this.registrations) {
      if (nextIds.has(id)) continue
      registration.routeDispose()
      registration.sidebarDispose()
      this.registrations.delete(id)
    }
    this.channels = [...channels]
    for (const [index, channel] of channels.entries()) {
      try {
        this.registerChannel(channel, index)
      } catch {
        // Keep every other channel live; periodic reconciliation retries this one.
      }
    }
  }

  upsertChannel(channel: CrewChannel): void {
    const next = [...this.channels.filter((item) => item.id !== channel.id), channel]
    void this.reconcile(next)
  }

  dispose(): void {
    this.disposed = true
    for (const registration of this.registrations.values()) {
      registration.routeDispose()
      registration.sidebarDispose()
    }
    this.registrations.clear()
  }

  private registerChannel(channel: CrewChannel, index: number): void {
    const existing = this.registrations.get(channel.id)
    const order = CHANNEL_ORDER_START + index
    if (existing && existing.channel.name === channel.name && existing.order === order) {
      return
    }
    existing?.sidebarDispose()
    const routeDispose = existing?.routeDispose ?? this.options.register({
      id: `channel-route-${channel.id}`,
      area: ROUTES_AREA,
      data: { path: channelPath(channel.id) } satisfies RouteContribution,
      render: () => this.options.renderChannel(channel.id),
    })
    const sidebarDispose = this.options.register({
      id: `channel-nav-${channel.id}`,
      area: SIDEBAR_NAV_AREA,
      order,
      data: {
        codicon: 'comment-discussion',
        label: channelLabel(channel.name, 0),
        path: channelPath(channel.id),
      } satisfies SidebarNavContribution,
    })
    this.registrations.set(channel.id, { channel, order, routeDispose, sidebarDispose })
  }
}
```

Implement `reconcile` so registration ids are stable (`channel-route-${id}` and `channel-nav-${id}`), routes render `options.renderChannel(id)`, sidebar orders start at 56, and unchanged channel/order/label registrations are retained. Re-register only the sidebar row if its name, order, or future unread label changes; re-register the route only when first seen.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: reconciliation tests pass and typecheck exits zero.

- [ ] **Step 5: Commit dynamic reconciliation**

```bash
git add src/desktop/channel-navigation.tsx tests/desktop/channel-navigation.test.tsx
git commit -m "feat: register Crew channels in native sidebar"
```

---

### Task 3: Add Persisted Unread Counts and Idempotent Event Processing

**Files:**
- Modify: `src/desktop/channel-navigation.tsx`
- Modify: `tests/desktop/channel-navigation.test.tsx`

**Interfaces:**
- Consumes: `CrewApi.events(after)`, socket `/events` frames, `EventFrame`, `PluginStorage`.
- Produces:
  - `ChannelNavigationController.start(): () => void`
  - `ChannelNavigationController.setViewedChannel(channelId: string | null): void`
  - `ChannelNavigationController.processEvents(frames: EventFrame[]): void`
  - persisted `ChannelNavigationState` at `NAVIGATION_STORAGE_KEY`.

- [ ] **Step 1: Add failing unread-state tests**

Add these behaviors to `tests/desktop/channel-navigation.test.tsx` using the registration and storage fixtures:

```tsx
function controllerFixture(options: {
  channels: CrewChannel[]
  events?: (after: number) => Promise<EventFrame[]>
  pollIntervalMs?: number
  register?: (item: PluginContribution) => () => void
  socket?: (path: string, listener: (data: unknown) => void) => () => void
  state?: ChannelNavigationState
  storage?: PluginStorage
}) {
  const storage = options.storage ?? memoryStorage(
    options.state ? { [NAVIGATION_STORAGE_KEY]: options.state } : {},
  )
  return new ChannelNavigationController({
    api: {
      listChannels: vi.fn(async () => options.channels),
      events: vi.fn(options.events ?? (async () => [])),
    },
    register: options.register ?? registrationHarness().register,
    renderChannel: (id) => <div data-channel={id} />,
    socket: options.socket ?? vi.fn(() => vi.fn()),
    storage,
    pollIntervalMs: options.pollIntervalMs,
  })
}

it('increments an inactive channel once for a completed agent result', async () => {
  const storage = memoryStorage({
    [NAVIGATION_STORAGE_KEY]: { version: 1, lastEventSequence: 4, unreadByChannel: {} },
  })
  const { live, register } = registrationHarness()
  const controller = controllerFixture({ storage, register, channels: [general] })
  await controller.reconcile()

  controller.processEvents([
    { sequence: 5, type: 'completed', channelId: general.id, turnId: 'turn-1', payload: { messageId: 'agent-message' } },
    { sequence: 5, type: 'completed', channelId: general.id, turnId: 'turn-1', payload: { messageId: 'agent-message' } },
  ])

  expect([...live.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: SIDEBAR_NAV_AREA, data: expect.objectContaining({ label: '# general (1)' }) }),
  ]))
  expect(storage.get(NAVIGATION_STORAGE_KEY, null)).toEqual({
    version: 1, lastEventSequence: 5, unreadByChannel: { [general.id]: 1 },
  })
})

it('counts thread replies by channel but ignores non-result events', async () => {
  const controller = controllerFixture({
    state: { version: 1, lastEventSequence: 10, unreadByChannel: {} },
    channels: [general],
  })
  await controller.reconcile()

  controller.processEvents([
    { sequence: 11, type: 'streaming', channelId: general.id, turnId: 'turn-2', payload: { text: 'work' } },
    { sequence: 12, type: 'routing_decision', channelId: general.id, turnId: null, payload: {} },
    { sequence: 13, type: 'completed', channelId: general.id, turnId: 'turn-2', payload: { messageId: 'thread-reply' } },
  ])

  expect(controller.unreadCount(general.id)).toBe(1)
})

it('does not count messages in the visible channel and clears persisted unread on view', async () => {
  const controller = controllerFixture({
    state: { version: 1, lastEventSequence: 20, unreadByChannel: { [general.id]: 3 } },
    channels: [general],
  })
  await controller.reconcile()

  controller.setViewedChannel(general.id)
  controller.processEvents([
    { sequence: 21, type: 'completed', channelId: general.id, turnId: 'turn-3', payload: { messageId: 'visible-result' } },
  ])

  expect(controller.unreadCount(general.id)).toBe(0)
})
```

Add malformed-state and deleted-channel cleanup tests:

```tsx
it('normalizes corrupt persisted counts and ignores malformed events', async () => {
  const storage = memoryStorage({
    [NAVIGATION_STORAGE_KEY]: {
      version: 1,
      lastEventSequence: 7,
      unreadByChannel: { [general.id]: -2, unknown: 1.5 },
    },
  })
  const controller = controllerFixture({ channels: [general], storage })
  await controller.reconcile()

  controller.processEvents([
    { sequence: Number.NaN, type: 'completed', channelId: general.id, turnId: 'bad', payload: { messageId: 'bad' } },
    { sequence: 8, type: 'completed', channelId: general.id, turnId: 'empty', payload: { messageId: '' } },
  ])

  expect(controller.unreadCount(general.id)).toBe(0)
  expect(controller.lastEventSequence()).toBe(8)
})

it('removes unread state when its channel is deleted', async () => {
  const storage = memoryStorage({
    [NAVIGATION_STORAGE_KEY]: {
      version: 1,
      lastEventSequence: 9,
      unreadByChannel: { [general.id]: 2, [research.id]: 4 },
    },
  })
  const controller = controllerFixture({ channels: [general, research], storage })
  await controller.reconcile()

  await controller.reconcile([general])

  expect(storage.get(NAVIGATION_STORAGE_KEY, null)).toEqual({
    version: 1, lastEventSequence: 9, unreadByChannel: { [general.id]: 2 },
  })
})
```

Add the persisted recreation test:

```tsx
it('restores unread counts and the cursor after controller recreation', async () => {
  const storage = memoryStorage({
    [NAVIGATION_STORAGE_KEY]: { version: 1, lastEventSequence: 2, unreadByChannel: {} },
  })
  const first = controllerFixture({ channels: [general], storage })
  await first.reconcile()
  first.processEvents([
    { sequence: 3, type: 'completed', channelId: general.id, turnId: 'turn', payload: { messageId: 'reply' } },
  ])

  const restored = controllerFixture({ channels: [general], storage })

  expect(restored.unreadCount(general.id)).toBe(1)
  expect(restored.lastEventSequence()).toBe(3)
})
```

- [ ] **Step 2: Run unread tests to verify red**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
```

Expected: FAIL because unread processing, `unreadCount`, and visibility methods do not exist.

- [ ] **Step 3: Implement state loading, normalization, processing, and row refresh**

Add to `ChannelNavigationController`:

```ts
private state: ChannelNavigationState = this.loadState()
private viewedChannelId: string | null = null

lastEventSequence(): number {
  return this.state.lastEventSequence
}

unreadCount(channelId: string): number {
  return this.state.unreadByChannel[channelId] ?? 0
}

setViewedChannel(channelId: string | null): void {
  this.viewedChannelId = channelId
  if (channelId && this.unreadCount(channelId) > 0) {
    delete this.state.unreadByChannel[channelId]
    this.persist()
    this.refreshSidebar(channelId)
  }
}

processEvents(frames: EventFrame[]): void {
  for (const frame of [...frames].sort((a, b) => a.sequence - b.sequence)) {
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.state.lastEventSequence) continue
    this.state.lastEventSequence = frame.sequence
    const messageId = frame.payload.messageId
    if (
      frame.type === 'completed' &&
      typeof messageId === 'string' && messageId.length > 0 &&
      frame.channelId !== this.viewedChannelId &&
      this.registrations.has(frame.channelId)
    ) {
      this.state.unreadByChannel[frame.channelId] = this.unreadCount(frame.channelId) + 1
      this.refreshSidebar(frame.channelId)
    }
  }
  this.persist()
}
```

Implement `loadState()` with strict `version === 1`, safe non-negative integer cursor, and positive safe-integer counts only. Track whether valid state existed in a separate `hadPersistedState` boolean for bootstrap. `refreshSidebar(id)` must dispose and re-register that channel's sidebar contribution with its current count and stable order. Change `registerChannel` to call `channelLabel(channel.name, this.unreadCount(channel.id))`. `reconcile` must remove unread keys for deleted channels and persist the cleanup.

- [ ] **Step 4: Add failing bootstrap, socket, polling, and disposal tests**

Use fake timers and explicitly controlled promises:

```tsx
it('seeds a new installation at the latest historical sequence without unread counts', async () => {
  const events = vi.fn(async () => [
    { sequence: 40, type: 'completed', channelId: general.id, turnId: 'old', payload: { messageId: 'old-result' } },
  ])
  const controller = controllerFixture({ channels: [general], events, state: undefined })

  const dispose = controller.start()
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(0))

  expect(controller.unreadCount(general.id)).toBe(0)
  expect(controller.lastEventSequence()).toBe(40)
  dispose()
})

it('deduplicates the same completion from socket and polling', async () => {
  vi.useFakeTimers()
  let socketMessage: (data: unknown) => void = () => undefined
  const frame = { sequence: 51, type: 'completed', channelId: general.id, turnId: 'new', payload: { messageId: 'new-result' } }
  const events = vi.fn(async (after: number) => after === 0 ? [] : [frame])
  const controller = controllerFixture({
    channels: [general], events,
    socket: (_path, listener) => { socketMessage = listener; return vi.fn() },
    state: { version: 1, lastEventSequence: 50, unreadByChannel: {} },
    pollIntervalMs: 20,
  })
  const dispose = controller.start()
  await vi.waitFor(() => expect(events).toHaveBeenCalled())

  socketMessage(frame)
  await vi.advanceTimersByTimeAsync(20)

  expect(controller.unreadCount(general.id)).toBe(1)
  dispose()
  vi.useRealTimers()
})
```

Add explicit single-flight, retry, and disposal tests:

```tsx
it('allows only one event poll in flight', async () => {
  vi.useFakeTimers()
  let resolveSlow!: (frames: EventFrame[]) => void
  const events = vi.fn()
    .mockResolvedValueOnce([])
    .mockImplementationOnce(() => new Promise<EventFrame[]>((resolve) => { resolveSlow = resolve }))
    .mockResolvedValue([])
  const controller = controllerFixture({
    channels: [general], events,
    state: { version: 1, lastEventSequence: 1, unreadByChannel: {} },
    pollIntervalMs: 20,
  })
  const dispose = controller.start()
  await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1))

  await vi.advanceTimersByTimeAsync(60)
  expect(events).toHaveBeenCalledTimes(2)
  resolveSlow([])
  await vi.advanceTimersByTimeAsync(20)
  expect(events).toHaveBeenCalledTimes(3)
  dispose()
  vi.useRealTimers()
})

it('retries failed channel discovery without overlapping reconciliations', async () => {
  vi.useFakeTimers()
  let resolveRetry!: (channels: CrewChannel[]) => void
  const listChannels = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => new Promise<CrewChannel[]>((resolve) => { resolveRetry = resolve }))
    .mockResolvedValue([general])
  const controller = new ChannelNavigationController({
    api: { listChannels, events: vi.fn(async () => []) },
    register: registrationHarness().register,
    renderChannel: (id) => <div data-channel={id} />,
    socket: vi.fn(() => vi.fn()), storage: memoryStorage(),
    reconcileIntervalMs: 20,
  })
  const dispose = controller.start()
  await vi.waitFor(() => expect(listChannels).toHaveBeenCalledTimes(1))

  await vi.advanceTimersByTimeAsync(60)
  expect(listChannels).toHaveBeenCalledTimes(2)
  resolveRetry([general])
  await vi.advanceTimersByTimeAsync(20)
  expect(listChannels).toHaveBeenCalledTimes(3)
  dispose()
  vi.useRealTimers()
})

it('disposes sockets and timers and ignores late work', async () => {
  vi.useFakeTimers()
  const socketDispose = vi.fn()
  let resolveEvents!: (frames: EventFrame[]) => void
  const events = vi.fn(() => new Promise<EventFrame[]>((resolve) => { resolveEvents = resolve }))
  const controller = controllerFixture({
    channels: [general], events,
    socket: vi.fn(() => socketDispose), pollIntervalMs: 20,
    state: { version: 1, lastEventSequence: 1, unreadByChannel: {} },
  })
  const dispose = controller.start()
  await vi.waitFor(() => expect(events).toHaveBeenCalled())

  dispose()
  resolveEvents([{ sequence: 2, type: 'completed', channelId: general.id, turnId: 'late', payload: { messageId: 'late' } }])
  await vi.advanceTimersByTimeAsync(100)

  expect(socketDispose).toHaveBeenCalledOnce()
  expect(controller.unreadCount(general.id)).toBe(0)
  vi.useRealTimers()
})
```

- [ ] **Step 5: Run lifecycle tests to verify red**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
```

Expected: lifecycle tests fail because `start`, bootstrap, polling, and socket handling are missing.

- [ ] **Step 6: Implement controller lifecycle**

Implement `start()` with this behavior:

```ts
start(): () => void {
  if (this.started) return () => this.dispose()
  this.started = true
  const socketDispose = this.options.socket('/events', (data) => {
    const frame = this.asEventFrame(data)
    if (!frame) return
    if (!this.bootstrapped) this.pendingFrames.push(frame)
    else this.processEvents([frame])
  })
  this.socketDispose = socketDispose
  void this.bootstrap()
  this.pollTimer = window.setInterval(() => { void this.pollEvents() }, this.options.pollIntervalMs ?? 2_000)
  this.reconcileTimer = window.setInterval(() => { void this.reconcileOnce() }, this.options.reconcileIntervalMs ?? 10_000)
  return () => this.dispose()
}
```

`bootstrap()` attempts channel reconciliation first but catches that failure so event bootstrapping and the periodic reconciliation retry still start. If no valid state existed, call `events(0)`, seed the cursor to the maximum valid sequence without counting, persist it, mark bootstrapped, then process only queued frames above that cursor. If state existed, poll after its cursor and process normally. `pollEvents` returns immediately until `bootstrapped` is true. `pollEvents` and `reconcileOnce` each use a boolean in-flight guard and clear it in `finally`. `dispose` clears both interval handles and the socket.

- [ ] **Step 7: Run controller tests and typecheck**

Run:

```bash
npm test -- tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: all controller tests pass with no unhandled promises or fake-timer leakage.

- [ ] **Step 8: Commit unread lifecycle**

```bash
git add src/desktop/channel-navigation.tsx tests/desktop/channel-navigation.test.tsx
git commit -m "feat: persist Crew channel unread counts"
```

---

### Task 4: Wire Dynamic Navigation into Plugin Registration

**Files:**
- Modify: `src/desktop/plugin.tsx`
- Modify: `tests/desktop/plugin.test.tsx`

**Interfaces:**
- Consumes: `ChannelNavigationController`, `ctx.register`, `ctx.storage`, `ctx.socket`, `host.navigate`.
- Produces: static `/crew` route plus controller-owned `/crew/channel/{id}` routes and sidebar rows for the plugin lifecycle.

- [ ] **Step 1: Rewrite the plugin registration test as a lifecycle test**

In `tests/desktop/plugin.test.tsx`, use complete context fields and await controller bootstrap:

```tsx
it('starts dynamic channel navigation alongside the static Crew surface', async () => {
  const contributions = new Map<string, PluginContribution>()
  const register = vi.fn((item: PluginContribution) => {
    contributions.set(item.id, item)
    return () => { contributions.delete(item.id) }
  })
  const cleanups: Array<() => void> = []
  const rest = vi.fn(async (path: string) => {
    if (path === '/channels') return [channel]
    if (path === '/events?after=0') return []
    throw new Error(`Unexpected REST path: ${path}`)
  })
  const ctx = {
    rest,
    socket: vi.fn(() => vi.fn()),
    register,
    registerMany: vi.fn((items: PluginContribution[]) => {
      const disposers = items.map(register)
      return () => disposers.forEach((dispose) => dispose())
    }),
    onDispose: vi.fn((cleanup: () => void) => { cleanups.push(cleanup) }),
    storage: memoryStorage(),
  }

  plugin.register(ctx as never)
  await vi.waitFor(() => expect([...contributions.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: SIDEBAR_NAV_AREA, data: expect.objectContaining({ label: '# general' }) }),
  ])))

  cleanups.forEach((cleanup) => cleanup())
  expect([...contributions.values()].some((item) => item.id.includes('channel-nav'))).toBe(false)
})
```

Retain assertions for the static route, static Crew row, palette command, plugin id, and `defaultEnabled`.

- [ ] **Step 2: Run the plugin test to verify red**

Run:

```bash
npm test -- tests/desktop/plugin.test.tsx
```

Expected: FAIL because `plugin.register` does not create or start the navigation controller.

- [ ] **Step 3: Construct the controller in `plugin.register`**

Update `src/desktop/plugin.tsx`:

```tsx
const api = new CrewApi(ctx.rest)
let navigation: ChannelNavigationController

const renderCrewPage = (initialChannelId?: string) => (
  <CrewPage
    api={api}
    initialChannelId={initialChannelId}
    onChannelCreated={(channel) => navigation.upsertChannel(channel)}
    onChannelViewed={(channelId) => navigation.setViewedChannel(channelId)}
    onNavigateChannel={(channelId) => host.navigate(channelId ? channelPath(channelId) : '/crew')}
  />
)

navigation = new ChannelNavigationController({
  api,
  register: ctx.register,
  renderChannel: (channelId) => renderCrewPage(channelId),
  socket: ctx.socket,
  storage: ctx.storage,
})
```

Keep the three static contributions, but render the static page with `renderCrewPage()`. Start the controller with `ctx.onDispose(navigation.start())` after static registration. Keep `GatewayWorker` unchanged.

- [ ] **Step 4: Run plugin and controller tests**

Run:

```bash
npm test -- tests/desktop/plugin.test.tsx tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: plugin lifecycle, controller tests, and typecheck pass.

- [ ] **Step 5: Commit plugin wiring**

```bash
git add src/desktop/plugin.tsx tests/desktop/plugin.test.tsx
git commit -m "feat: start native Crew channel navigation"
```

---

### Task 5: Integrate Dedicated Channel Routes with CrewPage

**Files:**
- Modify: `src/desktop/views/crew-page.tsx`
- Modify: `tests/desktop/channel-flow.test.tsx`

**Interfaces:**
- Consumes:
  - `initialChannelId?: string`
  - `onChannelCreated?(channel: CrewChannel): void`
  - `onChannelViewed?(channelId: string | null): void`
  - `onNavigateChannel?(channelId: string | null): void`
- Produces: selected-channel routing, visible read-state callbacks, creation navigation, and missing-channel fallback.

- [ ] **Step 1: Add failing route-selection and visibility tests**

Add to `tests/desktop/channel-flow.test.tsx`:

```tsx
it('selects a dedicated route channel and reports it visible', async () => {
  const { api } = apiFixture()
  const onChannelViewed = vi.fn()
  vi.mocked(api.listChannels).mockResolvedValue([channel, { ...channel, id: 'research', name: 'research' }])

  render(<CrewPage api={api} initialChannelId="research" onChannelViewed={onChannelViewed} />)

  expect(await screen.findByRole('region', { name: '#research' })).not.toBeNull()
  await waitFor(() => expect(onChannelViewed).toHaveBeenLastCalledWith('research'))
})

it('clears channel visibility in Studio and returns native navigation to Crew root', async () => {
  const { api } = apiFixture()
  const onChannelViewed = vi.fn()
  const onNavigateChannel = vi.fn()
  render(<CrewPage api={api} initialChannelId={channel.id} onChannelViewed={onChannelViewed} onNavigateChannel={onNavigateChannel} />)
  await screen.findByText(rootMessage.content)

  fireEvent.click(screen.getByRole('button', { name: 'Studio' }))

  await waitFor(() => expect(onChannelViewed).toHaveBeenLastCalledWith(null))
  expect(onNavigateChannel).toHaveBeenCalledWith(null)
})
```

Add separate tests that internal channel selection calls `onNavigateChannel(id)`, channel creation calls both `onChannelCreated(created)` and `onNavigateChannel(created.id)`, and an absent `initialChannelId` calls `onNavigateChannel(null)` while selecting the first existing channel.

- [ ] **Step 2: Run channel flow tests to verify red**

Run:

```bash
npm test -- tests/desktop/channel-flow.test.tsx
```

Expected: FAIL because `CrewPageProps` lacks route and lifecycle callbacks.

- [ ] **Step 3: Implement route-aware page state**

Change the interface in `src/desktop/views/crew-page.tsx`:

```ts
export interface CrewPageProps {
  api: CrewApi
  initialChannelId?: string
  onChannelCreated?(channel: CrewChannel): void
  onChannelViewed?(channelId: string | null): void
  onNavigateChannel?(channelId: string | null): void
}
```

During initial load, select `initialChannelId` only if it exists. If an explicit id is missing, call `onNavigateChannel?.(null)` and select the first channel. Add a visibility effect:

```ts
useEffect(() => {
  const visible = view === 'channels' ? selectedId : null
  onChannelViewed?.(visible)
  return () => { onChannelViewed?.(null) }
}, [onChannelViewed, selectedId, view])
```

Use one `selectChannel(id)` function to set the selected id, close the thread, set the channels view, and call `onNavigateChannel?.(id)`. Search and Studio buttons must set their view, call `onChannelViewed?.(null)` through state, and call `onNavigateChannel?.(null)` so only the main Crew row is active.

After `createChannel`, call `onChannelCreated?.(created)` followed by `selectChannel(created.id)`. Apply the same callbacks to `FirstRun.onComplete`.

- [ ] **Step 4: Run channel flow, plugin, and controller tests**

Run:

```bash
npm test -- tests/desktop/channel-flow.test.tsx tests/desktop/plugin.test.tsx tests/desktop/channel-navigation.test.tsx
npm run typecheck
```

Expected: dedicated route, visibility, creation, and missing-channel tests pass.

- [ ] **Step 5: Commit page integration**

```bash
git add src/desktop/views/crew-page.tsx tests/desktop/channel-flow.test.tsx
git commit -m "feat: navigate Crew channels through native routes"
```

---

### Task 6: Verify, Package, Record, and Install the Release

**Files:**
- Modify: `CHANGELOG.md`
- Generated: `dist/desktop-plugins/hermes-crew/plugin.js`
- Generated: `dist/release/hermes-crew-0.1.0.tar.gz`
- Install target: `/home/g2v/.hermes/desktop-plugins/hermes-crew/plugin.js`

**Interfaces:**
- Consumes: all prior tasks and the existing release scripts.
- Produces: verified local v0.1.0 bundle installed into Hermes with matching source/install hashes.

- [ ] **Step 1: Run the complete release gate**

Run:

```bash
.venv/bin/pytest -q
npm test
npm run typecheck
npm run build
npm run verify:dist
npm run package
git diff --check
```

Expected: 60 Python tests plus the expanded TypeScript/UI suite pass; typecheck, build, runtime import verification, package, and diff check exit zero.

- [ ] **Step 2: Inspect the built artifact with Hermes 0.20's exact scanner**

Run:

```bash
node /tmp/hermes-crew-inspect-imports.mjs dist/desktop-plugins/hermes-crew/plugin.js
sha256sum dist/desktop-plugins/hermes-crew/plugin.js dist/release/hermes-crew-0.1.0.tar.gz
```

Expected: scanner output is `[]`; record both printed SHA-256 values.

- [ ] **Step 3: Update release evidence**

Edit `CHANGELOG.md` to:

- add dynamic native channel navigation and persisted unread-count semantics;
- update the TypeScript/UI test count to the exact `npm test` result;
- replace the Desktop plugin and archive SHA-256 lines with the exact values printed in Step 2;
- retain Hermes Agent `0.20.0`, Hermes Desktop package `0.17.0`, schema `2`, and the existing acceptance evidence.

- [ ] **Step 4: Rebuild after changelog staging and verify hashes remain correct**

Run:

```bash
npm run build
npm run verify:dist
npm run package
sha256sum dist/desktop-plugins/hermes-crew/plugin.js dist/release/hermes-crew-0.1.0.tar.gz
git diff --check
```

Expected: the plugin hash is unchanged; update the changelog archive hash if packaging the changelog changes it, then rerun `npm run package` once and confirm the recorded archive hash matches.

- [ ] **Step 5: Commit and retag the verified release**

```bash
git add CHANGELOG.md
git commit -m "docs: record dynamic sidebar release evidence"
git tag -f v0.1.0
```

- [ ] **Step 6: Install into the real Hermes home**

Run with the existing external-write approval:

```bash
.venv/bin/python scripts/install.py --hermes-home /home/g2v/.hermes
```

Expected: installer reports Hermes Crew installed and preserves `/home/g2v/.hermes/crew/crew.db`.

- [ ] **Step 7: Verify the installed artifact**

Run:

```bash
sha256sum dist/desktop-plugins/hermes-crew/plugin.js /home/g2v/.hermes/desktop-plugins/hermes-crew/plugin.js
node /tmp/hermes-crew-inspect-imports.mjs /home/g2v/.hermes/desktop-plugins/hermes-crew/plugin.js
hermes plugins list --plain --no-bundled
git status --short
```

Expected: source and installed plugin hashes match, scanner output is `[]`, `hermes-crew` is `enabled user 0.1.0`, and the worktree is clean.

- [ ] **Step 8: Restart and manually exercise the native sidebar**

After restarting Hermes Desktop:

1. Confirm `Crew` is followed by one native row per current channel.
2. Create a channel and confirm its row appears without restarting.
3. Send a tagged message in channel A, switch to channel B before completion, and confirm channel A becomes `# channel-a (1)`.
4. Open channel A and confirm the response is visible and its count clears.
5. Generate a thread reply while channel A is inactive and confirm channel A increments.
6. Open Studio and confirm it renders without the Hermes `MenuItem` context error.

- [ ] **Step 9: Commit any evidence-only correction if Step 8 changes recorded counts or hashes**

If no files changed, skip this step. Otherwise run the full release gate again, then:

```bash
git add CHANGELOG.md
git commit -m "docs: refresh dynamic sidebar verification evidence"
git tag -f v0.1.0
```
