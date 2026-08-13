# Architecture

Hermes Crew is one product shipped into two hosts from a single codebase, with a
Python backend that runs inside the Hermes agent process.

```
┌────────────────────────────┐   ┌─────────────────────────────┐
│ Hermes Desktop (Electron)  │   │ Hermes web dashboard        │
│  desktop-plugins/…/plugin.js│   │  dashboard/dist/index.js    │
│  ESM, React from host SDK  │   │  IIFE, React via shims      │
│  + inlined scoped styles   │   │  + scoped style.css         │
└─────────────┬──────────────┘   └──────────────┬──────────────┘
              │ ctx.rest / host.request          │ fetchJSON
              ▼                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Python backend (FastAPI router, loaded by Hermes)            │
│  routing · scheduler · context builder · intent · search     │
│  SQLite: $HERMES_HOME/crew/crew.db (WAL, migrations)         │
└──────────────────────────────────────────────────────────────┘
              ▲
              │ session.create / prompt.submit / message.* events
┌─────────────┴──────────────┐
│ Hermes gateway (per turn)  │  real agent sessions, stored in
│ driven by GatewayWorker    │  $HERMES_HOME/state.db by Hermes
└────────────────────────────┘
```

## Source layout

```
src/
  desktop/            Shared React UI + desktop plugin entry
    views/            crew-page (shell), home, channel, thread,
                      studio (Agent Lab), session-console
    components/       composer, message rows, activity panel, …
    markdown.tsx      dependency-free Markdown → React renderer
    conversation-model.ts  message grouping + turn summaries
    gateway-worker.ts  claims turns, drives gateway sessions
    channel-navigation.tsx dynamic sidebar channels + unread counts
    style.css          Tailwind input for the DESKTOP stylesheet
  dashboard/          Dashboard entry + shims + token layer
    plugin.tsx         registers the page, measures host chrome,
                       detects light/dark from host background
    style.css          Tailwind input for the DASHBOARD stylesheet
    *-shim.ts          react/react-dom/plugin-sdk adapters
  backend/hermes_crew_backend/
    api.py             FastAPI routes (channels, messages, turns, identity:
                       /me, /members, /image-generation, avatar generation,
                       profiles, search, events, transcripts)
    routing.py         deterministic recipient selection + loop caps
    scheduler.py       turn lifecycle, result placement, journal
    context_builder.py bounded per-turn prompts + response contract
    intent.py          intent envelope parsing (with placement)
    schedules.py       recurring channel messages as Hermes cron jobs
                       (tokenless script jobs posting via normal routing)
    steward.py         off-by-default rule-based sweeps that unblock
                       stalled chains (re-plan unserved recipients, retry
                       orphaned turns); throttled off worker claim polls
    repositories.py / db.py  SQLite access + migrations
plugin/               Manifests + dashboard FastAPI adapter
skills/hermes-crew/   The crew-collaboration agent skill
scripts/              build.mjs, install.py, verify-dist.mjs, package.mjs
```

## The two hosts

**Hermes Desktop** loads `plugin.js` as native ESM with `react` and
`@hermes/plugin-sdk` provided by the host. The host ships **no utility CSS for
plugins**, so the build compiles a scoped stylesheet (`.hermes-crew-desktop`)
from the same sources and **inlines it into the bundle**; the plugin injects it
on registration. Colors bridge to host theme tokens (`--background`,
`--foreground`, `--ui-*`), so Crew follows the active Desktop theme live. The
only Crew-defined color token is `--ui-surface-secondary` (hover surfaces),
derived from the host foreground via `color-mix`.

**The web dashboard** loads an IIFE bundle whose `react` imports are shimmed to
the host-provided SDK React. Its stylesheet is scoped to
`.hermes-crew-dashboard` and defines a self-contained neutral palette (light
and dark) — host themes contribute only the accent color. This is deliberate:
some Hermes themes are monochrome, and inheriting their full palette destroys
text hierarchy. Light/dark is chosen by measuring the host background's
luminance, re-checked via `MutationObserver` on theme switches.

**Container queries everywhere.** Hosts wrap the plugin in variable chrome
(sidebars, file panels), so viewport breakpoints lie. Every responsive layout
in Crew (`@2xl:`/`@3xl:`/`@4xl:`/`@5xl:` variants) measures the plugin's own
container. The Agent Lab grid, channel rails, and the composer each define
their own container context.

## Message and turn flow

1. A user message is `POST`ed with idempotency key, mentions, and project
   scope. The **router** (`routing.py`) selects recipients deterministically:
   default responder, mentions, activation policies, and optionally a
   classifier suggestion. Each planned turn records a routing decision in the
   journal.
2. The **scheduler** persists turns and exposes claims. The
   **GatewayWorker** (running in the Desktop plugin) claims turns, creates a
   real Hermes gateway session, submits the bounded context prompt built by
   `context_builder.py`, and streams gateway events back as journal events.
3. On completion the agent's final text is parsed by `intent.py`: visible prose
   plus a hidden **intent envelope** (`<!-- hermes-crew:intent {...} -->`).
   The envelope's `placement` decides where the answer lands (follow the
   trigger / thread / channel); its intent and recipients feed the router for
   agent-to-agent follow-ups.
4. **Loop enforcement** walks the causal chain of turns
   (`trigger_message_id → result_message_id`), not thread containment:
   depth caps, pair-repeat caps, and automated-turn budgets bound uninterrupted
   agent relays wherever messages land. A human-authored trigger resets the
   chain.
5. The UI polls `/events` (2s cadence; a `/events` websocket also exists for
   sidebar unread tracking) into a per-channel-fair journal window, backfilling
   the selected channel's history via `?channel_id=&limit=`; turn
   summaries derive **only from state-bearing event types** (the journal also
   records informational frames like `session_info` and `routing_decision`
   after terminal states).

## Sessions

Each turn stores its Hermes session ids. "Open session" opens the **native**
session view in both hosts: the dashboard deep-links
`/chat?resume=<storedSessionId>`, Hermes Desktop routes `/<storedSessionId>`
(its router resolves any single-segment non-core path as a session). The
per-turn menu also offers the in-Crew **session console** — transcript read by
the backend from Hermes' own session store (`$HERMES_HOME/state.db`,
read-only), live continuation over the gateway (`session.resume` →
`prompt.submit`, `message.delta`/`message.complete` events,
`session.interrupt` to stop) — for working without leaving the workspace.

Host-detection warning: never identify the host by sniffing SDK globals such
as `__HERMES_PLUGIN_SDK__` — Hermes Desktop's plugin loader also assigns them
to `globalThis`, timing-dependent on plugin load order. Crew's dashboard entry
sets `window.__HERMES_CREW_HOST__ = 'dashboard'` and everything keys off that.

The transcript endpoint couples to two tables of Hermes' `state.db`
(`sessions{id,title,model}`, `messages{session_id,role,content,timestamp}`).
If that schema moves, `GET /sessions/{id}/transcript` is the only touchpoint.

## Data model (crew.db)

Channels, messages (threads via `root_message_id`), channel members with
activation policies, turns (with causal trigger/result links and session ids),
activity events (the journal), approvals, session bindings, member
presentation, workspace `settings` (the human user's identity), FTS search
documents. Migrations are append-only and versioned in
`schema_migrations`; migration 3 is an example of a data repair (promoting
legacy synthetic-thread answers into channel timelines).

## Design system

- Shared components use semantic tokens (`--ui-accent`,
  `--ui-stroke-secondary`, `--ui-text-secondary/tertiary`, `bg-background`,
  `text-foreground`) so each host's token layer decides the look.
- `bg-background`/`text-foreground` utilities only exist if declared via
  `@theme inline` in each stylesheet — Tailwind generates named-color utilities
  from theme keys, not from plain CSS variables.
- The dashboard host lacks the codicon icon font; the dashboard stylesheet
  ships SVG-mask fallbacks for every codicon Crew uses.
- Markdown rendering (`markdown.tsx`) builds React nodes directly — no HTML
  strings, no injection surface, no dependencies.
