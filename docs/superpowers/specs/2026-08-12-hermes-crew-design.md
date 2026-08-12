# Hermes Crew Design Specification

**Status:** Approved

**Date:** 2026-08-12

## 1. Summary

Hermes Crew is a local, single-user collaboration workspace inside Hermes Desktop. It lets one person work with multiple persistent Hermes profiles as visible teammates in shared channels. Each teammate retains an independent identity, SOUL, provider, model, skills, tools, memory, sessions, credentials, workspace settings, and permissions.

The v1 compatibility target is Hermes Agent `0.20.0`. At the pinned upstream reference commit, the nested Desktop package reports `0.17.0`; that package number is tracked as an SDK-contract detail and is not the Hermes Crew compatibility floor.

Crew is a coordination layer over Hermes rather than a replacement runtime. Hermes remains authoritative for profiles, sessions, models, skills, tools, memory, projects, and execution. Crew adds channels, threads, membership, routing policies, structured message intents, agent-to-agent activation controls, project-scoped conversations, activity history, and a role-oriented Crew Studio.

The first release is local-only and single-user. It deliberately excludes shared cloud workspaces and multi-human synchronization.

## 2. Product Goals

Hermes Crew must:

1. Make persistent Hermes profiles feel like distinct, understandable team members.
2. Let multiple agents participate in a shared conversation without responding to every message or entering uncontrolled loops.
3. Give each agent independent model, provider, reasoning, fallback, capability, and workspace configuration.
4. Support both dedicated project channels and general-purpose channels that temporarily attach work to a project.
5. Keep project-specific thread work isolated from unrelated channel conversation.
6. Make agent work inspectable through streaming, tool activity, results, artifacts, verification, blockers, and approvals.
7. Reuse Hermes's native primitives and visual language instead of maintaining duplicate profile or execution systems.
8. Recover predictably after a Desktop, backend, provider, or agent failure.

## 3. Non-Goals

The first release will not provide:

- Multiple human accounts or real-time human-to-human collaboration.
- A remotely synchronized relay or hosted workspace.
- A mobile client.
- Voice calls or huddles.
- Non-Hermes agent runtimes.
- A visual workflow builder.
- Unbounded autonomous debates.
- A replacement for Hermes sessions, memory, skills, projects, or native settings.
- Security isolation based only on profile identity or SOUL instructions.

## 4. Design Principles and Inspirations

### 4.1 Profiles are members, not disposable workers

Every visible crew member maps to a real Hermes profile. Temporary subagents may be spawned behind that identity by Hermes, but they do not become top-level channel identities.

### 4.2 Shared rooms, scoped execution

The channel is the human-facing shared context. Each executing agent still uses its own Hermes session, configuration, memory, and tools. Project-scoped threads receive isolated session bindings.

### 4.3 Structured routing, natural presentation

Messages look conversational, but agent outputs carry a hidden structured envelope that tells Crew whether the message is informational, a result, a question, a handoff, a review request, a blocker, or an approval request.

### 4.4 Inspectable work

The interface borrows Buzz's strongest idea: agents are members with visible work, scoped access, history, and outcomes. It does not copy Buzz's network relay or identity protocol.

### 4.5 Contextual invocation

The experience borrows the mention pattern associated with Grok and Claude in Slack: an agent can be invited into an existing conversation and receive the relevant surrounding context. Threads keep longer work from flooding the main channel.

### 4.6 Native before duplicated

Crew uses Hermes UI components, theme variables, profile/config APIs, session APIs, skill APIs, project APIs, and event streams. The first release adds one primary `Crew` destination. It deep-links to existing Hermes management surfaces when those provide a clearer low-level editor. Deeper integration into existing Hermes sidebar sections can be evaluated after the coordinated experience works reliably.

## 5. Core Domain Model

### 5.1 Crew member

A Crew member is a Hermes profile plus Crew-specific presentation, membership, and routing metadata.

Hermes-owned fields include:

- Profile identifier and filesystem home.
- Provider, model, reasoning setting, and fallback model.
- SOUL.
- Skills, tools, MCP configuration, and credentials.
- Memory and native sessions.
- Default working directory and project configuration.

Crew-owned fields include:

- Display name, avatar, color, role, and short description.
- Channel memberships.
- Activation defaults.
- Intent and reply-budget preferences.
- Allowed-project restrictions that are more restrictive than the underlying Hermes access.
- Presentation state such as archived membership.

Deleting a Crew membership does not delete its Hermes profile. Deleting a Hermes profile causes the corresponding Crew member to become archived and unavailable for new turns while preserving message history.

### 5.2 Channel

A channel is a local shared conversation with:

- Name, purpose, and optional topic.
- Members and per-member activation policy.
- One optional default responder.
- Optional default Hermes project.
- Optional allowed-project list.
- Routing, classifier, cost, depth, and reply-budget policies.
- Pinned context and attachments.
- Message and thread history.

An unassigned channel has no default project and resolves work through the selected agent's normal Hermes context.

### 5.3 Thread

A thread is a focused conversation rooted at one channel message. It inherits project context from its root message unless explicitly changed for the thread. Each agent participating in the thread receives a thread-scoped Hermes session.

### 5.4 Message

A message contains visible content, attachments, authorship, timestamps, reply relationships, optional project context, and optional hidden intent metadata. Human messages do not require hidden metadata.

### 5.5 Turn and causal chain

A turn is one agent execution caused by a message. Turns form an explicit causal graph. A human message begins a new causal chain and resets its automated reply budget. Agent messages may create additional turns only through valid structured intents and named recipients.

### 5.6 Activity event

An activity event is an append-only normalized record of execution state, including queued, started, streaming, tool activity, approval waiting, completion, failure, cancellation, and interruption.

## 6. System Architecture

Hermes Crew uses a native Desktop frontend and a scoped Python backend.

```text
Hermes Desktop plugin
  - Crew route and sidebar contribution
  - Channels, threads, composer, Studio, activity UI
  - Hermes UI kit and theme
  - host.request for native Hermes operations
  - host.onEvent for gateway and session events
             |
             | scoped REST and socket connection
             v
Crew Python backend
  - SQLite persistence
  - message router and scheduler
  - context builder
  - intent validation
  - causal graph and loop prevention
  - project and session binding
  - recovery and activity journal
             |
             | Hermes gateway APIs
             v
Hermes
  - profiles and config
  - models and credentials
  - sessions and streaming
  - skills, tools, memory, and projects
  - execution and interruption
```

### 6.1 Frontend responsibilities

The Desktop plugin owns presentation and direct interaction:

- Channel, thread, roster, activity, and Studio screens.
- Composer, mentions, project picker, attachments, and commands.
- Optimistic message insertion followed by backend acknowledgment.
- Concurrent streaming from multiple agent turns.
- Approval, cancellation, retry, and inspection controls.
- Navigation or deep links to native Hermes surfaces.
- Client-side accessibility, keyboard behavior, and responsive layout.

Business rules do not live exclusively in the renderer. Closing or reloading the Crew page must not corrupt routing state.

### 6.2 Backend responsibilities

The Python backend owns durable coordination:

- Database migrations and persistence.
- Message ingestion with idempotency keys.
- Recipient resolution and routing precedence.
- Turn scheduling and concurrency limits.
- Intent schema validation and optional classification.
- Causal depth, total-turn, pair-repeat, and correlation-loop enforcement.
- Project context resolution and access checks.
- Hermes session creation and binding.
- Context assembly.
- Event normalization and append-only activity records.
- Restart recovery and retry eligibility.

### 6.3 Hermes responsibilities

Hermes remains the source of truth for:

- Profile lifecycle and profile home directories.
- Model/provider configuration and authentication.
- SOUL, skills, tools, MCPs, memory, and credentials.
- Projects and working directories.
- Agent sessions, tool execution, streaming, interruption, and native history.

Crew stores stable references and cached display snapshots only where necessary to render historical content.

## 7. Routing Model

### 7.1 Activation policies

Every channel member has one activation policy:

```ts
type ActivationPolicy =
  | "always"
  | "mentioned"
  | "observer"
  | "disabled";
```

- `always`: runs for every human-authored top-level message in that channel.
- `mentioned`: runs only when explicitly mentioned or validly addressed by an agent intent.
- `observer`: receives no automatic turns but remains visible and may be explicitly promoted by user action.
- `disabled`: cannot be routed work in that channel.

A channel may also designate one member as its default responder. This is equivalent to a channel-scoped `always` rule but is represented separately in the UI because it is a primary channel concept.

### 7.2 Recipient resolution

For a human message, Crew resolves candidates in this order:

1. Explicitly mentioned members.
2. The channel's default responder.
3. Other members with `always` activation.
4. Optional classifier suggestions when the classifier is enabled.

For an agent message, Crew resolves candidates in this order:

1. Named recipients in a valid reply-bearing structured intent.
2. Optional classifier correction when enabled.

An agent message never triggers default responders or all members merely because their policy is `always`. This prevents ordinary agent status messages from causing fan-out.

If the same member is selected by more than one rule, the triggers collapse into a single turn that records every matching reason.

### 7.3 Structured message intents

Agent outputs carry a hidden envelope separate from visible prose:

```json
{
  "schemaVersion": 1,
  "intent": "review_request",
  "recipients": ["critic"],
  "replyExpected": true,
  "replyBudget": 1,
  "correlationId": "turn_01J...",
  "summary": "Authentication design is ready for review"
}
```

Supported intents are:

```ts
type MessageIntent =
  | "inform"
  | "result"
  | "reply_required"
  | "question"
  | "handoff"
  | "review_request"
  | "blocked"
  | "approval_request";
```

Semantics:

- `inform`: information or status only; never triggers another turn.
- `result`: completed work; never triggers another turn unless a separate review recipient is explicitly included and allowed.
- `reply_required`: named agent recipients must answer if budget and policy allow.
- `question`: named agents may answer, or the chain pauses for the user when no agent recipient is supplied.
- `handoff`: transfers work ownership to one named member.
- `review_request`: asks named reviewer members to inspect a result.
- `blocked`: stops the chain and exposes the blocker to the user.
- `approval_request`: pauses the chain until the user approves, rejects, or edits the request.

Invalid, missing, or unparseable metadata is normalized to `inform`. It is never interpreted as a reply request.

### 7.4 Trust and optional classifier

By default, Crew trusts agent-declared metadata after deterministic schema and policy validation. A channel can optionally configure a separate classifier model with its own provider, model, credentials reference, reasoning setting, and token budget.

The classifier is disabled by default. When enabled, it may:

- Validate that visible content matches the declared intent.
- Downgrade a reply-bearing intent to `inform`.
- Correct recipients to existing channel members.
- Flag an ambiguous message for the user.

It may not bypass disabled membership, permissions, project restrictions, approval gates, or reply budgets.

### 7.5 Loop and cost controls

Every causal chain records:

- Human root message.
- Parent and child turn edges.
- Current automated depth.
- Total automated turns.
- Remaining reply budget.
- Ordered agent-pair transitions.
- Correlation identifiers.
- Estimated or reported model usage.

Crew blocks dispatch when any configured limit is exhausted. Repeating the same directed agent pair or correlation transition beyond its allowance is treated as a loop. A human reply creates a fresh causal budget but does not erase the audit history.

The user can stop an individual turn, all descendants of a message, or all activity in a channel.

### 7.6 First-release defaults

New channels use conservative, editable defaults:

- Maximum automated agent-to-agent depth: `2`.
- Maximum automated agent turns in one human-rooted chain: `6`.
- Maximum repeated directed transition between the same two agents: `1`.
- Default reply budget emitted by a reply-bearing intent: `1`.
- Maximum reply budget an agent may request without a channel override: `2`.
- Maximum concurrently running turns in one channel: `4`.
- Classifier: disabled.
- `@all`: allowed only for members whose policy is not `disabled`, and only on human-authored messages.

When an agent requests a larger budget than policy permits, Crew clamps it to the applicable channel maximum and records the adjustment. Changing a channel default affects new causal chains only; in-flight chains keep the policy snapshot recorded at creation.

## 8. Model and Crew Member Configuration

Every member may independently use a different provider and model. For example, a coding member can use an OpenAI model, a research member can use Gemini, and a reviewer can use Claude.

Crew Studio exposes:

- Primary provider and model.
- Reasoning or effort setting when supported.
- Optional fallback provider and model.
- Optional per-turn token or cost budget.
- Credential readiness without exposing secret values.
- Model availability and readiness tests.

Crew writes settings supported natively by Hermes to the corresponding profile. Any Crew-level fallback or turn-budget setting without a native Hermes equivalent remains in Crew's database and is applied by the router. Model changes apply to new turns. If Hermes requires a new session for a clean configuration boundary, Crew creates a replacement binding and preserves the old session reference for history.

The optional classifier uses a separate configuration and never silently inherits a member's high-cost model.

## 9. Project Context

Hermes projects may be attached to a channel, a message, or a thread.

### 9.1 Resolution order

Project context resolves from most specific to least specific:

```text
explicit thread project
  -> root-message project
  -> channel default project
  -> agent/profile default project
  -> global or unassigned Hermes context
```

An explicit `global` selection is a real override and prevents inheritance from a channel default.

### 9.2 Dedicated project channels

A channel may set a default project. New top-level messages inherit it unless their composer selection overrides it. This supports channels dedicated to one repository or workspace.

### 9.3 General channels and message overrides

In an unassigned or general-purpose channel, the user may attach a project to a single message. That project applies to the message's complete causal chain. If the message becomes a visible thread, the thread continues using the same project. Other top-level messages in the channel continue using the channel default or global context.

Project-scoped top-level messages receive a logical thread scope immediately, even before the user opens a thread UI. This prevents project work from entering the channel's global session.

### 9.4 Session binding

The stable binding identity is conceptually:

```text
(channel_id, scope_id, profile_id, project_context_id)
```

`scope_id` identifies either the channel mainline or a root message/thread. The resolved project identifier is included so a session cannot be silently reused with a different working directory or project context.

### 9.5 Project safety

Before dispatch, Crew resolves the project through Hermes and checks:

- The project still exists.
- The member is allowed to use it.
- The working directory is valid.
- Required permissions are satisfied.

Renamed projects are remapped by stable identity where Hermes exposes one. Missing projects preserve history but block new work until the user selects a replacement or global context.

## 10. Context Assembly

Each turn receives the smallest context that preserves conversational correctness:

1. Channel name, purpose, and applicable rules.
2. The triggering message and direct parent.
3. Relevant recent channel messages.
4. Complete current-thread history within configured limits.
5. Participant identities, roles, and mention mapping.
6. Resolved project and working-directory context.
7. Pinned channel or thread context and selected attachments.
8. Trigger reason and any incoming structured intent.
9. The response-envelope schema and intent rules.
10. Remaining causal depth, reply budget, and approval state.

The context builder does not copy secrets, raw credentials, hidden system prompts, or unrelated private profile memory into Crew messages. Hermes may apply the profile's own memory and system configuration inside its session as usual.

## 11. User Experience

### 11.1 Navigation

Hermes Crew contributes one primary `Crew` sidebar destination. The page uses Hermes-native components and visual tokens.

The default layout has three areas:

```text
channels and agents | conversation or Crew Studio | context and activity
```

The left area includes channels, direct agent conversations, the member roster, and saved activity views. The center hosts the selected conversation, thread, or Studio editor. The right area shows project context, members, routing policies, running turns, budgets, pinned context, and artifacts.

### 11.2 Channel view

The channel header shows:

- Name and purpose.
- Default project.
- Default responder.
- Active-agent count.
- Routing-policy shortcut.
- Search and settings actions.

Messages display human or agent identity, project, model, intent where useful, and execution state. Tool activity is streamed and collapsible. Results summarize artifacts, changed files, verification, blockers, and disposition.

Handoffs and review requests render as linked transitions. Approval requests render as explicit decision cards rather than ordinary text.

### 11.3 Composer

The composer supports:

- Agent mentions and `@all` for explicitly enabled members.
- Project selection: channel default, recent project, explicit global, or another allowed project.
- File and repository-reference attachments.
- Visible project and recipient chips before sending.
- Stop, retry, approval, rules, and thread commands.

`/roundtable` and visual workflow commands are deferred until the core routing model is proven.

### 11.4 Crew Studio

Crew Studio is a master-detail editor with these sections:

- Identity: name, avatar, color, role, and description.
- Brain: provider, model, reasoning, fallback, and SOUL.
- Capabilities: skills, tools, MCPs, and computer access.
- Workspace: default project, working directory, and allowed projects.
- Behavior: activation defaults, intent behavior, and response budgets.
- Permissions: filesystem, terminal, network, and approval requirements.
- Knowledge: memory visibility and reset controls supported by Hermes.
- Diagnostics: readiness, credential status, sessions, and current activity.

Creating a member follows a short guided flow:

1. Create or select a Hermes profile.
2. Configure identity and role.
3. Select provider and model.
4. Write, paste, or generate SOUL.
5. Select skills and tools.
6. Configure project access and permissions.
7. Add the member to channels.
8. Run a readiness check.

Advanced settings remain available without blocking the first successful response.

### 11.5 First-run experience

The initial setup creates or offers to create:

- `#general` with global/unassigned project context.
- One selected profile as the default responder.
- A sample message explaining mentions and project attachment.
- No automatic agent-to-agent behavior beyond valid structured intents.

## 12. Persistence Model

The Crew SQLite database contains at least these logical tables:

- `channels`
- `channel_members`
- `member_presentation`
- `activation_rules`
- `messages`
- `message_recipients`
- `threads`
- `turns`
- `turn_edges`
- `session_bindings`
- `approvals`
- `activity_events`
- `classifier_configs`
- `pinned_context`
- `attachments`

Messages and activity records are append-oriented. Mutable configuration tables use version or update timestamps. Turn dispatch uses idempotency keys so a UI retry or reconnect cannot create duplicate executions.

Historical records keep stable display snapshots for author name, avatar, model label, and project label. These snapshots do not become configuration sources of truth.

## 13. Execution Lifecycle

A normal human message follows this flow:

1. Frontend submits message with channel, optional thread, mentions, project selection, attachments, and idempotency key.
2. Backend persists and acknowledges the message.
3. Router resolves project context and intended recipients.
4. Permission, readiness, budget, and membership checks run.
5. Backend creates queued turns and causal edges.
6. Context builder assembles the profile-specific prompt and metadata contract.
7. Backend resolves or creates the Hermes session binding.
8. Hermes begins execution and streams messages and tool activity.
9. Backend normalizes events and forwards them to the UI.
10. The final visible response and hidden envelope are persisted.
11. Intent validation determines whether child turns, approval waiting, or completion follows.

An agent-originated message begins at step 10 and can create a child turn only when all routing and budget rules permit it.

## 14. Failure Handling and Recovery

- A failed member turn does not cancel sibling turns.
- Provider failures expose retry and configured fallback actions.
- Missing credentials or unavailable models fail readiness checks before dispatch.
- Invalid intent metadata becomes non-triggering `inform`.
- A failed classifier falls back to the validated agent-declared intent; it never blocks a message by default.
- A removed profile becomes an archived member and cannot receive new work.
- A missing project preserves history and blocks project-bound dispatch until remapped.
- A cancelled turn records who or what cancelled it and whether tool execution acknowledged interruption.
- On backend restart, queued turns are reconciled and running turns are marked `interrupted` unless Hermes confirms they are still active.
- Interrupted turns are offered for explicit idempotent retry and are never silently replayed.
- Socket loss falls back to bounded polling where supported by the Hermes plugin SDK.

## 15. Permissions and Privacy

Hermes profile separation does not itself provide filesystem sandboxing. Crew must present permissions accurately and defer enforcement to supported Hermes execution and sandbox controls.

Before dispatch, Crew checks channel membership, activation policy, project access, model readiness, and approval requirements. A model-generated intent cannot widen access.

Crew never stores raw API keys or provider credentials. It stores only profile references and readiness metadata. Hidden system prompts, credentials, and unrelated memory are excluded from shared message history.

Every automated turn records:

- The triggering message.
- The routing reasons.
- The applied rule versions.
- The resolved project.
- The selected model label.
- The budget before and after dispatch.
- The result disposition.

## 16. Observability

The append-only activity journal uses normalized states:

```text
queued
started
streaming
tool_started
tool_finished
waiting_approval
completed
failed
cancelled
interrupted
```

The UI exposes a readable explanation of why each agent ran. Diagnostic logs include correlation IDs but redact credentials and sensitive prompt content. The activity view can filter by channel, member, project, state, and causal chain.

## 17. Testing Strategy

### 17.1 Unit tests

Cover:

- Human and agent routing precedence.
- Duplicate recipient collapse.
- Intent schema validation and safe fallback.
- Reply, depth, and total-turn budgets.
- Pair-repeat and correlation-loop detection.
- Project resolution precedence, including explicit global override.
- Session binding isolation by root message, profile, and project.
- Permission and readiness decisions.
- Restart reconciliation rules.

### 17.2 Contract tests

Verify the Hermes APIs used for:

- Profile listing, creation, editing, archiving behavior, and readiness.
- Provider and model configuration.
- SOUL, skills, tools, and project access.
- Session creation, resumption, interruption, and history.
- Streaming message, tool, and lifecycle events.

Contract failures must identify whether Hermes changed an API or Crew violated the supported contract.

### 17.3 Integration tests

Run multiple configured profiles concurrently and validate:

- Independent model selection.
- Parallel streaming without message crossover.
- Cancellation of one turn without affecting siblings.
- Review and handoff chains.
- Approval pause and resume.
- Classifier enabled and disabled paths.
- Frontend reconnect and backend restart recovery.

### 17.4 UI and end-to-end tests

Cover:

- First-run setup.
- Channel and member creation.
- Crew Studio editing and readiness validation.
- Default responder plus mentioned responder behavior.
- Dedicated project channel execution.
- General-channel message project override and thread inheritance.
- Stop, retry, approval, failure, and archived-member states.
- A forced agent loop that terminates deterministically.

## 18. First-Release Scope

The first release includes:

- Local channels and threads.
- Persistent Hermes profile-backed members.
- Crew Studio with independent model configuration.
- Channel, message, and thread project attachment.
- Default-responder and mention routing.
- Per-member activation policies.
- Structured message intents.
- Agent-to-agent reply and loop budgets.
- Streaming responses and tool activity.
- Stop, retry, approval, and restart recovery.
- Local search and inspectable activity history.
- Optional per-channel classifier configuration, disabled by default.

## 19. Acceptance Criteria

The release is complete when all of the following hold:

1. A user can create or select two Hermes profiles, configure them with different providers/models, and add them to one channel.
2. The channel default responder answers every human message, while another member answers only when mentioned.
3. Informational agent responses do not trigger additional agents.
4. A valid review request triggers exactly one intended reviewer response within the configured budget.
5. A repeated agent-to-agent loop terminates deterministically and is explained in the activity view.
6. A channel default project applies to ordinary top-level messages.
7. A project attached to one message in a global channel applies to that message and its thread without changing later top-level messages.
8. Project-scoped thread sessions do not reuse the channel's global session binding.
9. The user can inspect streaming activity, artifacts, verification, blockers, routing reasons, and final disposition.
10. Stopping one agent does not stop independent sibling turns.
11. Restarting Hermes Desktop preserves channels, messages, rules, project mappings, and inspectable outcomes.
12. An interrupted turn is never silently executed twice.
13. Missing credentials, models, profiles, or projects produce actionable states rather than silent failure.
14. Crew stores no raw provider credentials.

## 20. Future Directions

After the first release is stable, possible extensions include:

- Deeper contributions inside Hermes's existing sidebar and management panes.
- Roundtables, reusable channel templates, and explicit workflow definitions.
- Hermes Kanban task integration.
- Remote Hermes member presence.
- Multi-human workspaces and a synchronized relay.
- Mobile clients and notifications.
- Voice collaboration.
- Additional agent runtimes behind a runtime-neutral member interface.

These directions must not distort the first-release data model into prematurely supporting distributed tenancy.

## 21. Source References

- Hermes Desktop Plugin SDK: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/desktop-plugin-sdk.md>
- Hermes Desktop guide: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/desktop.md>
- Hermes profiles guide: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md>
- Block Buzz README and architecture: <https://github.com/block/buzz/blob/main/README.md>
- Claude for Slack: <https://claude.com/claude-for-slack>
