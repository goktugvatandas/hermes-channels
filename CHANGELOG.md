# Changelog

## Unreleased — 2026-08-13

Schedules on Hermes cron:

- **Agent Lab → Automation → Schedules**: recurring channel messages as real Hermes cron jobs — tokenless `no_agent` script jobs (generated under `$HERMES_HOME/scripts/`, cleaned up on delete) that post through normal Crew routing, so scheduled kickoffs mentioning agents start full relays. Presets plus raw cron/interval cadences, pause/resume/run-now/delete, jobs tagged `origin: hermes-crew` and visible on the host's own Cron page. Covered by an end-to-end test that executes a generated script against a real crew.db.

The Steward (experimental):

- A hidden, off-by-default automation agent that unblocks stalled lifecycles on a schedule: rule-based sweeps (no model calls) re-plan messages whose named recipients never got a turn and retry orphaned interrupted turns, all still subject to routing budgets. `GET/PUT /steward` for settings, `POST /steward/sweep` for a manual pass; sweeps ride the worker claim polls.
- **Routing limits are configurable** in Agent Lab → Automation → Limits: workspace-default budgets (automation turns, chain depth, pair repeats, concurrency) with per-channel overrides, layered built-ins < workspace < channel. Each field explains what it caps and that a human message resets the budget.
- Settings UI in **Agent Lab → Automation** (toggle, cadence, stall threshold, run-now), plus an **editable judgment model**: pick a cheap catalog model and ambiguous stalls (nothing named, nothing in flight) get one bounded judgment call per message — executed through the existing classification-turn worker path — whose verdict wakes members via the normal routing caps. Clearable back to rules-only.

Agent-to-agent relays actually relay (found live via a 5-agent, 4-provider demo; four stacked bugs each silently produced the same "default envelope" symptom):

- **Plain-text intent markers.** The gateway sanitizes HTML comments out of message frames, so the comment-based contract never reached the worker; the marker is now `[[hermes-crew:intent {...}]]` (old form still parses).
- **Completion waits for the whole reply.** Models send one reply as several assistant messages, with the envelope marker in a trailing short message; the worker used to complete on the first `message.complete`. It now banks messages and finalizes after six quiet seconds, joining the full text.
- **Multiple markers merge** (recipients union, strongest scheduling intent, max budget, first explicit placement) instead of being discarded — models emit one marker per delegation plus a wrap-up.
- **The envelope validator accepts `placement`.** The frontend key-allowlist predated the field the contract itself mandates, so even perfectly-formed envelopes were rejected wholesale.
- **The collector pattern works.** A `result` envelope that names recipients wakes them once — a delegate finishing with "returning this to Athena" now actually brings Athena back to consolidate (observed live: Thoth's threaded result named her and she never responded). Recipient-less results and prose thanks stay terminal, and all loop budgets still apply.
- **Agent text-mentions route.** "@freya please analyze…" with an empty envelope now wakes Freya (display-name handles included), under the same depth/budget/pair caps; terminal intents stay silent. `question` counts as reply-bearing everywhere.
- Worker turns heartbeat every 60s so silently-reasoning models aren't reaped; the `anthropic` SDK is documented as required for MiniMax/Anthropic-compatible providers.

Cross-host recovery fix:

- **Workers now heartbeat their turns.** The first stale-reap design treated journal frames as liveness — but reasoning models can stream nothing for minutes while thinking, so a healthy turn died at the three-minute mark (found live on the second demo run: last streaming frame 15:05:40, reaped 15:08:40). The gateway worker now POSTs `/turns/{id}/heartbeat` every 60s for each turn it drives, the reap keys on `MAX(journal activity, heartbeat)` with a five-minute window, and heartbeats on settled turns are refused. Covered by a silent-reasoning regression test.
- **A booting backend no longer kills the other host's live turns.** Hermes Desktop's embedded server and the web dashboard share crew.db, and either one starting up used to blanket-interrupt every claimed/running turn — opening the dashboard mid-relay killed turns the Desktop worker was actively driving (found live: a 5-agent handoff demo died the moment a second surface loaded). Recovery is now stale-aware: in-flight turns are only reaped after three minutes of journal silence (streaming/tool events count as liveness), the reap also runs opportunistically from the claim poll so real orphans still get cleaned without a restart, and the single-host crash-restart semantics remain available via `stale_after_ms=0`. Covered by a cross-host regression test.

Branding:

- Generated project icon (`assets/icon.png`, made with Hermes image generation), centered README header, a Quickstart section, and a no-affiliation notice for Nous Research / Hermes Agent.

Second code-quality sweep (four parallel reviewers; all confirmed findings applied):

- **Routing honors the skill's contract for questions.** `intent: "question"` with named recipients now schedules them (it silently scheduled no one), and the collaboration skill's intent table was corrected to match routing exactly (`inform`/`result`/`blocked` are informational).
- **Avatar inputs are validated.** `PATCH /members/{id}` and `/me` reject non-`data:image/` avatars (a remote URL would have turned every roster render into a tracking beacon) and cap sizes; explicit nulls on non-nullable member fields are ignored instead of surfacing as 500s/409s; `/me/avatar/generate` re-reads identity after the slow generation so it can't revert a concurrent rename; the per-call image-model env override is fully serialized (a concurrent no-override generation could read the other request's model).
- **Composer correctness.** A synchronous in-flight guard stops Enter key-repeat from posting duplicate messages (each carried a fresh idempotency key the server couldn't dedupe); mention resolution now token-scans with the same boundaries the popup and highlighter accept (`(@Name` and `@Name,` count) and builds no RegExp from names, so a profile named `team(` can't wedge the composer.
- **Editors keep your edits.** The Agent Lab identity editor resets only when you switch profiles — previously any resolving save handed back a fresh member object and wiped in-progress SOUL/name edits, cancelling pending debounced saves. The Profile view preserves dirty fields across background refreshes and generation.
- **Event buffer is per-channel-fair** (newest 800 per channel instead of a global cap that evicted a quiet channel's backfilled history in the same merge that added it), and the events endpoint takes a `limit`. Thread resizing survives releases outside the window (`buttons===0` detection + `pointercancel` + unmount cleanup) and thread panes are keyed by root so switching threads can't leak the previous thread's messages or pending turns. Activity Stop/Retry failures re-enable the button and announce instead of dying silently.
- **Idempotent writes take the write lock up front** (`BEGIN IMMEDIATE`) so a concurrent client retry dedupes instead of bouncing off the UNIQUE constraint as a 409, and migration 2's FTS backfill is guarded against replay after a crash between script and version marker. FTS search strips NUL bytes that crashed sqlite.
- Dead code removed (`state.ts`, session-nav leftovers, `labelWithoutName`/`turn.label`, unused imports); README/ARCHITECTURE/CHANGELOG/skill brought back in line with shipped behavior (composer commands, native session navigation on both hosts, identity endpoints, settings table).

Composer and threads:

- **The thread pane is resizable.** Drag the divider on its left edge (280–640px, persisted); the divider doubles as the visual separation between channel and thread. The composer lost its top border so the input card floats cleanly in both panes.
- **Tool activity can no longer show finished work as running.** `tool_started`/`tool_finished` frames are paired into one card per invocation (by call id, then name, then order), and any tool inside a settled turn renders as finished even if the journal dropped the finish frame. Activity headers wrap instead of clipping the "Open session" button, and that button now also lives in each entry's ⋯ menu and in the agent message ⋯ Activity section.
- **Activity is newest-first, capped at five with "Load more", and never scrolls sideways** (message-preview quotes clamp instead of widening the rail). The working row under a renamed agent no longer shows the stale profile-id phrasing ("Odin" above, "Default is working…" below); the second line is just the state now. Agent messages' ⋯ menu gained an **Activity** section showing that turn's timeline (queued → claimed → session → completed) right on the message. Selecting a channel also backfills its event history, so a busy sibling channel can no longer starve a quiet channel's activity rail and message menus out of the rolling event buffer.
- **Channel details actually describe the channel.** Members show stored display names and avatars with activity-based presence ("Working now" while a turn runs) instead of a permanently-offline gateway dot and provider/model noise. Activity entries lead with the member's avatar and current display name, a status ring, and a quote of the message the turn answers (queued events now carry `triggerMessageId`/`triggerExcerpt`; migration 6 keeps the excerpt out of the search index so messages don't match twice).

- **The composer footer replaces the header controls.** The project-scope selects and the @all/@agent chip row are gone; a folder icon next to Send opens the scope menu (inherit / global / project with profile + project pickers), and a chip appears beside it only when the message deviates from the channel default. Threads show a passive chip for their inherited project.
- **@handles follow display names.** Mention suggestions, highlighting, and resolution use the member's display name with punctuation stripped (rename "default" to "Odin" and it becomes @Odin); profile-id handles keep working, and both resolve to the profile id the router matches on.
- **Threads show agents working.** The thread pane now renders the same pending-turn indicator as the channel timeline for turns it starts, and refetches replies when those turns complete — answers appear without closing and reopening the thread.

Avatars and identity:

- **Generation is configurable per run.** "Generate from profile" now opens a modal that asks for the image model (the Hermes-configured default preselected, cheaper tiers one click away — e.g. GPT Image 2 Low/Medium/High with speed hints from the provider catalog) and an optional custom prompt. Custom prompts are enhanced server-side with avatar framing (square, centered, no text); an empty prompt keeps the profile-derived brief.
- **You can generate too.** The user profile gained the same generate flow (`POST /me/avatar/generate`), not just upload.
- **Profile is a first-class view.** The Search pill in the Crew nav is replaced by Profile (search stays reachable via the composer `/search` command); Home links to it. The user profile is a full page now instead of a dialog.
- **Mythological name generator.** A sparkle button next to the agent Display name rolls names that feel mythological — half curated (Athena, Freya, Amaterasu…), half invented from myth-sounding syllables (Seliel, Thalyra…).
- Unexpected backend errors now surface as structured `internal_error` responses with the exception type and message, so a failed save shows something actionable in the inspector instead of a bare "Internal Server Error".

- **Avatar customization for agents and for you.** The Agent Lab identity section now has an avatar editor: eight palette colors, image upload (client-side downscaled to a small square data URL), and — when the host Hermes install has image generation configured — a **"Generate from profile"** button that has Hermes paint a portrait from the agent's display name, role, description, and SOUL excerpt (`POST /members/{id}/avatar/generate`; the generated file is re-encoded to a ~256px WebP data URL in crew.db because the Hermes image cache is janitor-cleaned). Your own identity lives in a new `/me` endpoint (settings table, migration 5) with an "Edit your profile" dialog on Home: display name, avatar, color.
- **Stored avatars render everywhere.** A presentation context (members + user identity, refreshed on view changes) feeds message rows, the composer mention popup, channel headers, the Home crew strip, pending turns, the member roster, first-run, and the agent rail. User messages show your chosen display name instead of "You".

Model selection:

- **Provider and model dropdowns.** The Model editor and the per-channel classifier config in Behavior now populate from the live Hermes model catalog (`model.options` gateway RPC on Desktop, `/api/model/options` on the dashboard): configured providers only, models scoped to the chosen provider, so switches can only produce combinations Hermes accepts. Off-catalog values stay selectable as "(current)", and free-form inputs return automatically when the catalog is unreachable.

Sidebar:

- Channel entries drop the literal `#` prefix and use the codicon hash glyph (`symbol-numeric`) instead; the Agent Lab entry moved below the channel list (order 400 vs. channels at 56+) with a beaker icon.

Native session navigation:

- "Open session" now opens the **native Hermes session view in-app on both hosts**: the dashboard resumes in its chat (`/chat?resume=…`), and Hermes Desktop navigates its session route (`/<sessionId>` — the router resolves single-segment non-core paths as sessions). Every earlier failed attempt at this route was an artifact of the host-misdetection bug below. The in-Crew session console remains available from each turn's ⋯ menu ("Open in Crew console") for working without leaving the workspace.

Desktop "Open session" fix:

- Host detection no longer sniffs `__HERMES_PLUGIN_SDK__`: Hermes Desktop's own plugin loader also assigns that global (timing-dependent on plugin load order), so the desktop was intermittently misidentified as the web dashboard and "Open session" navigated to a fresh chat instead of opening the in-Crew session console. The dashboard entry now sets a Crew-owned `__HERMES_CREW_HOST__` marker and all host-specific behavior keys off it.
- The details rail is a module-level component again — defined inside `CrewPage` it became a new component type per render, so the 2s event poll remounted the rail mid-interaction and could eat clicks.
- The session console can no longer fail invisibly: it feature-detects `host.onEvent` (falling back to transcript polling for replies), translates "Hermes gateway unavailable" into an actionable message, and is wrapped in an error boundary that renders the failure instead of a dead surface.

Open-source hardening — eight-angle code review applied:

- **Routing safety restored and strengthened.** The causal-chain rewrite had made fan-outs escape automation budgets (each branch got a fresh budget; `max_automated_turns` was unreachable). Budgets now count the whole causal tree from the originating human message — including queued and in-flight turns and turns planned within the same routing pass — with new indexes (`turns.result_message_id`, `turns.trigger_message_id`), a single chain walk per plan, and a cycle-safe bound. Covered by new fan-out, relay-project, and session-scope regression tests.
- **Relay context restored.** Channel-level reply placement had silently dropped two things the old synthetic threads carried: message-scoped project inheritance (handoffs ran in the wrong working tree) and per-request session isolation (unrelated requests shared one agent session). Results now record their causal parent and inherit the trigger's message-scoped project; session scope resolves through the causal origin.
- **Migration 3 is now conservative**: legacy answers are only promoted out of synthetic threads that contain nothing else, so threads with human follow-ups stay intact.
- **UI correctness**: approved turns no longer freeze on "needs approval" (state events now include `approval_resolved`/`running`); Markdown italics no longer corrupt `snake_case`; `/all` works (stale-closure fix); the session console clears on any navigation; saved scroll offsets at the bottom keep auto-following; the dashboard's theme probe ignores unparseable modern color syntax instead of misreading it as dark; the copy-confirmation check glyph exists in the dashboard.
- **Robustness and performance**: the transcript endpoint runs in the threadpool, tolerates session-store schema drift, and maps store errors to 404; channel listings are bounded to the newest 500 messages; message rows are memoized with cached Markdown; streaming deltas batch per animation frame; the dashboard's chrome measurement coalesces per frame; the installer no longer deletes user-added skills sharing the category directory.
- **Structure**: shared `displayName`/`labelWithoutName` helpers, one intent-marker stripper, one host-detection function, a single details-rail implementation, and documented cross-process couplings.

Composer v3 — interactive mentions and slash commands:

- @mention autocomplete now works at the caret anywhere in the draft (not just at the end), with avatar cards showing each member's role or model, full keyboard navigation (arrows, Enter/Tab, Escape), mouse hover, and an @all entry. Valid mentions get live accent highlighting inside the input via a synced backdrop overlay.
- Slash commands: typing "/" at the start opens a command palette — /all (mention everyone), /inherit /global /project (message scope), /home /workshop /search (navigation, in the full Crew page), and /clear. Commands execute and consume the token; scope commands drive the same project picker.
- Mention toggles are now avatar chips inside the composer card next to the scope picker, and the footer hints at @, /, and Enter. Command chips carry explicit surface colors so host-global `code` styling can't blank them out.

In-app session console for Hermes Desktop:

- "Open session" in Hermes Desktop now opens a Crew-owned session console inside the workspace instead of bouncing to the browser: the full stored transcript (read from the agent's session store via a new `/sessions/{id}/transcript` backend endpoint), with crew turn contexts folded into expandable summaries, markdown rendering, and a live composer that resumes the session over the gateway (`session.resume` → `prompt.submit`), streams the agent's reply token-by-token (`message.delta`/`message.complete`), and supports Stop (`session.interrupt`). Messages sent here are direct agent conversation — they stay out of crew channels. The web dashboard keeps its native in-chat resume.

Markdown, readable activity, and hands-on session jumps:

- Channel and thread messages render Markdown through a dependency-free, injection-safe renderer (React nodes only): paragraphs, fenced code, ordered/unordered lists, quotes, headings, inline code, bold/italic, links, and @mentions.
- The activity panel reads like a story instead of a payload dump: each turn shows a human step timeline ("Queued → Claimed by a worker → Session started → Completed · inform"), tool runs get status dots and friendly summaries, result cards structure summary/artifacts/changed-files with the raw payload behind a disclosure, and Retry moved into a per-turn "More actions" menu.
- Every turn now carries its Hermes session id, and **Open session** is the activity panel's primary action: in the web dashboard it resumes the session in chat directly (`/chat?resume=…`); in Hermes Desktop it opens the same resumed session in the web dashboard via the system browser, because Desktop 0.17 exposes no working in-app session activation to plugins (later found incorrect — an artifact of the host-misdetection bug; see the Native session navigation entry) (its plugin `navigate` only matches plugin routes, the main-window router is in-memory, and the bridge's `openSessionWindow` spawns a window that never becomes visible).

Reply placement and the crew-collaboration skill:

- The intent envelope gains `placement` ("auto" | "thread" | "channel"): agents choose where their answer lands — follow the question (default), keep or start a thread under the trigger (work logs, side discussions), or post to the channel timeline even from a thread (final results). Humans choose the same way they always could: the channel composer posts to the channel, the thread pane's composer stays in the thread.
- New `crew-collaboration` skill ships with the plugin and installs into `$HERMES_HOME/skills/hermes-crew/`: a full guide to the intent envelope (every intent with when-to-use), placement, recipients and automation budgets, loop limits, mentions and activation policies, project scope, and human-collaboration etiquette. The per-turn response contract stays lean and points agents at the skill; the installer manages it (removed on uninstall).
- The message-details popover no longer clips: it flips upward for rows in the lower half of the timeline and wraps the message ID instead of overflowing.

Message actions and data migration:

- Copy now confirms itself: the icon flips to a green check with a "Copied" tooltip and a polite screen-reader announcement, then reverts. The formerly inert "…" button opens a message-details popover (sent time, author and model, project, and the message ID with its own copy action); Escape or leaving the row closes it.
- Schema migration 3 promotes agent answers that the old scheduler forced into synthetic threads back into the channel timeline, so conversations recorded before the threading fix read the same as new ones.

Channel/thread visual alignment:

- The thread and details rail headers now share the channel header's exact height, so the horizontal rules and day dividers line up across the pane boundary; the composer's project-scope row has a fixed minimum height so both composers start on the same line (verified to the pixel). The keyboard hint hides in narrow composers (the composer is its own container query context), and the programmatically focused Thread heading no longer draws a focus ring.

Navigation and state-correctness fixes:

- Home's "Now running" and the activity rail no longer show finished turns as running: the journal appends informational frames (session_info, routing_decision) after `completed`, and turn summaries now derive state only from state-bearing events.
- The Channels tab shows the in-page channels view instead of navigating the host to the standalone channel route; selecting or creating a channel inside Crew also stays inside Crew. The host sidebar's channel links remain the way to open standalone channel surfaces.
- Switching between /crew, /crew/agent-lab, and channel routes now follows the new route even when Hermes reuses the mounted page component — the sidebar Agent Lab entry opens the Agent Lab instead of whatever view was left behind.
- The thread pane renders its replies: the message list's root-only filter (correct for channel timelines) no longer applies in thread mode.

Agent replies now appear in the channel:

- Completed turns wrote every agent answer as a thread reply under the triggering message (`root_message_id` fallback to the trigger id), while the channel listing returned only root messages — so an agent's answer never appeared in the channel at all, and reply-count pills could never render. Answers now land where the question was asked: channel-level questions get channel-level answers, thread questions stay threaded. The messages API returns thread replies too (the UI needs them for reply counts); agent context building keeps the root-only listing so thread context isolation holds.
- Loop enforcement previously counted prior agent hops by thread containment, which the fix would have silently disabled. The router now walks the causal turn chain (turns' trigger→result lineage), so automation budgets bound uninterrupted agent-to-agent relays wherever messages land, and a human message in the chain resets the budget.
- Verified live end-to-end: a message sent through the UI produced an agent reply rendered inline in the channel in both the web dashboard and Hermes Desktop, with the native sidebar unread badge updating.

Container-aware responsive layout:

- Crew's grids now use CSS container queries against the plugin's own width instead of viewport media queries, which mis-sized layouts inside host chrome (Desktop's sidebar and file panel can leave the plugin under 500px in a tiled window). The Agent Lab collapses gracefully: icon-only section nav below ~768px container width, glance inspector appears at ≥1024px container width (the web dashboard override keeps it visible at its 1225px viewport). Channel details and thread rails switch between overlay and side-by-side at ~896px container width. Verified live in Hermes Desktop at both a half-tile (~460px effective width) and a large floating window.

Hermes Desktop rendering fix:

- The Desktop plugin now compiles and inlines its own scoped utility stylesheet (`.hermes-crew-desktop`) into `plugin.js` and injects it on registration. Hermes Desktop ships no utility classes for plugins (no arbitrary-value grid/flex utilities, no `--ui-surface-secondary` token), which collapsed every multi-column Crew layout — most visibly the Agent Lab — into a single vertical scroll. Colors bridge to the host's theme tokens (`--background`, `--foreground`, `--ui-*`) so Crew follows the active Desktop theme. `verify:dist` now asserts the inlined scoped styles are present. Verified live in Hermes Desktop (Hermes Local) via real-window screenshots: Home, the Agent Lab's four-zone layout, and the channel workspace all render correctly.

Crew reimagined (second pass):

- The Crew page is now an operational center: it lands on a Home view with crew status (agents, online count, channels), a "Now running" panel with live turn indicators and Stop controls, workspace cards for every channel, and recent activity. Channels remain the main workspaces, one click away.
- Studio is renamed **Agent Lab**. It has its own entry in the Hermes Desktop sidebar (`/crew/agent-lab`, ordered below the channel list), a palette command ("Open Agent Lab"), and a polished four-zone layout: richer agent rail with roles and presence, icon section nav with accent selection, consistent editor fields, and a card-based "At a glance" inspector.
- Composer refined again: auto-growing single-line-first input, pill mention chips with pressed states, inline project scope controls, elevated container with focus ring, and a rounded Send button.
- Message rows: mentions are highlighted in accent, hover actions float in a raised toolbar, reply counts are pill buttons with an icon ("Reply in thread"), model labels are chips, and pending turns show a typing indicator.
- Channel chrome: header with project chip and a member-avatars details button, details rail with header and close button, wider thread rail, restyled channel list and creation form, redesigned search view and first-run card.

Crew UI redesign (first pass):

- The dashboard now ships its own neutral design tokens (light and dark, selected by host background luminance) instead of inheriting the host theme's colors for text, borders, and surfaces; only the accent color follows the host. This fixes the all-blue rendering under monochrome host themes such as Nous Blue.
- The dashboard page measures its real top offset instead of assuming 4rem of host chrome, so the composer is no longer clipped at short viewports.
- Icon glyph fallbacks (SVG masks) cover every codicon Crew uses, so icon buttons render in the dashboard host, which lacks the codicon font.
- Message timelines pin to the newest message and stay pinned while you are at the bottom, with per-channel scroll positions still restored; day dividers (Today/Yesterday/date) separate the stream.
- Channel refetches after completed turns no longer clear the visible timeline first, removing a flicker.
- Composer reworked into a single container: mention chips with pressed states, project scope row, borderless input, Enter/Shift+Enter hint, and primary Send button.
- Deterministic pastel identity colors for avatar initials; segmented Channels/Search/Studio navigation; styled Stop/Retry, modal, and channel-list controls.

## 0.1.0 — 2026-08-12

Initial Hermes Crew release for one local user:

- Profile-backed crew members with independent Hermes model, provider, SOUL, skills, and tool configuration.
- Project-aware channels, message-scoped projects, inherited thread context, mentions, default responders, and per-channel activation policies.
- Structured hidden intent envelopes, deterministic reply routing, bounded handoffs, optional classifier configuration disabled by default, and durable activity/approval controls.
- SQLite persistence, restart recovery, full-text search, first-run onboarding, Crew Studio, installer, and reproducible release packaging.
- Hermes Desktop 0.20.0 runtime-loader compatibility verification for generated plugin imports.
- Completed agent turns now refresh their channel message stream, so persisted replies appear without leaving the channel.
- Crew Studio's native Hermes model catalog now renders inside the required dropdown context.
- Hermes Crew channels now appear dynamically in the native sidebar with dedicated routes, persisted `# name (N)` unread counts, live create/rename/delete reconciliation, and restart-safe event catch-up.
- Native channel sidebar routes now render a standalone channel surface instead of repeating the full Crew management shell.
- Switching between native channel sidebar routes now makes the new route authoritative, even when Hermes reuses the mounted page component.

### Acceptance evidence

- Automated release gate: 60 Python tests and 51 TypeScript/UI tests passed with no skipped acceptance scenarios.
- Hermes Agent: `0.20.0` (`2026.8.3`).
- Hermes Desktop package: `0.17.0`.
- Pinned Desktop SDK contract commit: `ee472a7fdbbc55924f91ab122dbaa29bd07668b0`.
- Host: Linux `7.1.4-arch1-1`, x86_64.
- Crew database schema: `2`.
- Desktop plugin SHA-256: `76efd83e1014352217a3224ea19625671246992a349835c32ae14cf5bef60dd4`.
- Release archive SHA-256: `8dacfcca112bec66423ad99bac2927e5906f1fa86c16de71aa7815dd9b90b650`.

A disposable real `HERMES_HOME` smoke test installed and enabled the packaged user plugin in Hermes 0.20.0, loaded its FastAPI routes, and created two `--no-skills` profiles: Atlas on OpenAI/GPT-5.6 and Scout on Google/Gemini 2.5 Pro. The real Crew API returned both profile configurations, routed a global message to mentioned Scout plus default Atlas, resolved a registered Hermes project into the Atlas claim's `cwd`, cancelled only Scout, preserved the Crew database across reinstall, and marked the remaining Atlas claims interrupted after backend restart.

The disposable home intentionally contained no provider credentials, so it made no billed model requests and did not claim a GUI streaming result. The contract-recording acceptance gateway covers independent effective models, completion markers, zero-child informational results, review/handoff bounds, project/thread inheritance, scoped stop, approval rejection, restart idempotency, and missing profile/model/project readiness failures.
