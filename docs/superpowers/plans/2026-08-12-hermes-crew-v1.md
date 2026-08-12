# Hermes Crew v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package a local Hermes Desktop plugin where one user coordinates persistent, independently configured Hermes profiles in project-aware channels with safe structured routing, threads, live activity, Crew Studio, and restart recovery.

**Architecture:** A maintainable TypeScript/React source tree bundles into the single ESM `plugin.js` required by Hermes Desktop. An always-loaded runtime worker claims durable dispatches from a FastAPI/SQLite backend, invokes Hermes JSON-RPC, and correlates gateway events. The backend owns channels, routing, causal budgets, project/session bindings, approvals, recovery, profile configuration, and the activity journal.

**Tech Stack:** Hermes Desktop Plugin SDK 0.17.0+, React 19, TypeScript 6, esbuild, Vitest, Testing Library, Python 3.11+, FastAPI, Pydantic 2, SQLite, pytest, Playwright.

## Global Constraints

- Compatibility floor: Hermes Desktop `0.17.0`; contract reference commit `ee472a7fdbbc55924f91ab122dbaa29bd07668b0` dated 2026-08-12.
- Runtime desktop artifact imports only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`; esbuild must bundle every internal frontend module and externalize those three specifiers.
- Hermes is authoritative for profiles, SOUL, model/provider settings, skills, tools, projects, credentials, and sessions.
- Crew is local and single-user. Do not add accounts, tenancy, relay synchronization, or non-Hermes runtimes.
- Crew never persists raw provider credentials, hidden Hermes system prompts, or unrelated profile memory.
- Profile identifiers and project paths are validated server-side before use; model-authored metadata never widens access.
- SQLite enables `foreign_keys=ON`, `journal_mode=WAL`, and `busy_timeout=5000` on every connection.
- IDs are lowercase UUID4 hex strings; timestamps are UTC epoch milliseconds.
- New channels default to depth `2`, automated turns `6`, repeated directed pair `1`, requested reply budget `1`, maximum requested reply budget `2`, and channel concurrency `4`.
- Classifier support ships configured but disabled; the default execution path never calls a classifier.
- Every task follows red-green-refactor and ends with a focused commit.

## Verified Hermes Contracts

The gateway worker may use only these RPCs until a contract fixture is deliberately updated:

```text
session.create    {cols, source, cwd?, profile?, model?, provider?, reasoning_effort?, fast}
session.resume    {session_id, profile?}
prompt.submit     {session_id, text, queued?}
session.interrupt {session_id}
approval.respond  {session_id?, request_id, choice}
llm.oneshot       {session_id, instructions, input, task, max_tokens, temperature}
projects.list     {}
model.options     {explicit_only?, include_unconfigured?, refresh?}
```

Required event names:

```text
session.info message.start message.delta message.complete
thinking.delta reasoning.delta status.update
tool.start tool.progress tool.complete
clarify.request approval.request error
```

`session.create` accepts a target `profile` and per-session model/provider/reasoning overrides. `ctx.rest` and `ctx.socket` are confined to `/api/plugins/hermes-crew`. The Python plugin file must export a FastAPI `router` and is mounted only when the user plugin is enabled.

## File Structure

```text
hermes-crew/
├── package.json                         # frontend build/test/package scripts
├── pyproject.toml                       # backend package and pytest configuration
├── tsconfig.json                        # strict browser TypeScript
├── vitest.config.ts                     # jsdom unit/component projects
├── .gitignore
├── src/
│   ├── desktop/
│   │   ├── plugin.tsx                   # HermesPlugin entry and permanent worker
│   │   ├── sdk.d.ts                     # narrow authoring declarations
│   │   ├── types.ts                     # frontend API/event contracts
│   │   ├── api.ts                       # ctx.rest client
│   │   ├── gateway-worker.ts            # dispatch claim and Hermes RPC bridge
│   │   ├── event-normalizer.ts          # RpcEvent -> Crew activity frames
│   │   ├── intent-marker.ts             # hidden marker strip/parser
│   │   ├── state.ts                     # query keys and selected-channel state
│   │   ├── views/crew-page.tsx          # three-column route shell
│   │   ├── views/channel-view.tsx        # message list and header
│   │   ├── views/thread-view.tsx         # root-scoped conversation
│   │   ├── views/studio-view.tsx         # profile/member master-detail editor
│   │   └── components/                   # composer, roster, activity, cards
│   └── backend/hermes_crew_backend/
│       ├── __init__.py
│       ├── api.py                        # FastAPI routes and WebSocket
│       ├── models.py                     # Pydantic domain/API models
│       ├── db.py                         # connection/migration/transactions
│       ├── repositories.py               # persistence queries
│       ├── project_context.py            # inheritance and validation
│       ├── intent.py                     # marker/envelope validation
│       ├── classifier.py                 # optional classifier scheduling/result validation
│       ├── routing.py                    # recipients and loop budgets
│       ├── context_builder.py             # bounded agent and classifier prompts
│       ├── scheduler.py                  # dispatch lifecycle/recovery
│       ├── event_bus.py                  # in-process subscribers
│       └── hermes_adapter.py              # profiles/projects/config bridge
├── plugin/
│   ├── plugin.yaml                       # enableable Hermes user plugin
│   ├── __init__.py                       # no-op general-plugin registration
│   └── dashboard/
│       ├── manifest.json                 # declares plugin_api.py
│       └── plugin_api.py                 # loads packaged backend router
├── scripts/
│   ├── build.mjs                         # bundle frontend and copy backend
│   ├── install.py                        # install into an owner Hermes profile
│   ├── package.mjs                       # reproducible release archive
│   └── verify-dist.mjs                   # import/path/secret checks
├── tests/
│   ├── contracts/hermes-0.17.0.json
│   ├── backend/
│   ├── desktop/
│   ├── integration/
│   └── e2e/
└── dist/                                 # generated, never edited by hand
```

---

### Task 1: Establish Tooling and Freeze the Hermes Contract

**Files:**
- Create: `package.json`
- Create: `pyproject.toml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `tests/contracts/hermes-0.17.0.json`
- Create: `tests/desktop/contract.test.ts`

**Interfaces:**
- Produces: the exact `HermesContract` fixture consumed by `gateway-worker.ts` and compatibility tests.

- [ ] **Step 1: Write the failing contract test**

```ts
import contract from '../contracts/hermes-0.17.0.json'
import { describe, expect, it } from 'vitest'

describe('Hermes 0.17.0 contract', () => {
  it('contains every RPC and event Crew depends on', () => {
    expect(contract.rpcs).toEqual([
      'approval.respond', 'llm.oneshot', 'model.options', 'projects.list', 'prompt.submit',
      'session.create', 'session.interrupt', 'session.resume'
    ])
    expect(contract.events).toContain('message.complete')
    expect(contract.events).toContain('tool.start')
  })
})
```

- [ ] **Step 2: Run the empty-repository test and verify failure**

Run: `npm test -- tests/desktop/contract.test.ts`

Expected: FAIL because `package.json` and the contract fixture do not exist.

- [ ] **Step 3: Add exact toolchain configuration and fixture**

Use Node `>=22.22.0`, scripts `build`, `test`, `typecheck`, `test:py`, `verify:dist`, and exact dev dependencies aligned with Hermes Desktop: TypeScript `6.0.3`, React `19.2.7`, esbuild `0.28.1`, Vitest `4.1.10`, jsdom `29.1.1`, and Testing Library React `16.3.2`. Configure Python `>=3.11`, `fastapi`, `pydantic>=2`, `pytest`, `pytest-asyncio`, and `httpx`.

```json
{
  "hermesDesktop": "0.17.0",
  "upstreamCommit": "ee472a7fdbbc55924f91ab122dbaa29bd07668b0",
  "rpcs": ["approval.respond", "llm.oneshot", "model.options", "projects.list", "prompt.submit", "session.create", "session.interrupt", "session.resume"],
  "events": ["approval.request", "clarify.request", "error", "message.complete", "message.delta", "message.start", "reasoning.delta", "session.info", "status.update", "thinking.delta", "tool.complete", "tool.progress", "tool.start"]
}
```

Ignore `node_modules/`, `.venv/`, `.pytest_cache/`, `coverage/`, and `dist/`.

- [ ] **Step 4: Run baseline checks**

Run: `npm test -- tests/desktop/contract.test.ts && npm run typecheck && pytest -q`

Expected: PASS; pytest reports no collected backend tests without error.

- [ ] **Step 5: Commit**

```bash
git add package.json pyproject.toml tsconfig.json vitest.config.ts .gitignore tests/contracts tests/desktop/contract.test.ts
git commit -m "chore: establish Hermes Crew toolchain and contract"
```

### Task 2: Define Domain Models and SQLite Migrations

**Files:**
- Create: `src/backend/hermes_crew_backend/__init__.py`
- Create: `src/backend/hermes_crew_backend/models.py`
- Create: `src/backend/hermes_crew_backend/db.py`
- Create: `tests/backend/test_db.py`
- Create: `tests/backend/test_models.py`

**Interfaces:**
- Produces: `ActivationPolicy`, `MessageIntent`, `ProjectRef`, `IntentEnvelope`, `DispatchClaim`, `CrewDatabase`.

- [ ] **Step 1: Write failing model and migration tests**

```python
def test_invalid_reply_envelope_is_rejected():
    with pytest.raises(ValidationError):
        IntentEnvelope(intent="review_request", recipients=[], reply_expected=True)

def test_migration_enables_sqlite_safety(tmp_path):
    db = CrewDatabase(tmp_path / "crew.db")
    with db.connect() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"channels", "messages", "turns", "activity_events", "session_bindings"} <= names
```

- [ ] **Step 2: Verify red state**

Run: `pytest tests/backend/test_models.py tests/backend/test_db.py -q`

Expected: FAIL with `ModuleNotFoundError: hermes_crew_backend`.

- [ ] **Step 3: Implement exact shared models**

```python
ActivationPolicy = Literal["always", "mentioned", "observer", "disabled"]
MessageIntent = Literal[
    "inform", "result", "reply_required", "question", "handoff",
    "review_request", "blocked", "approval_request",
]

class ProjectRef(BaseModel):
    mode: Literal["inherit", "global", "project"]
    profile: str | None = None
    project_id: str | None = None
    label: str | None = None
    cwd: str | None = None

    @model_validator(mode="after")
    def validate_project(self):
        if self.mode == "project" and not (self.profile and self.project_id and self.cwd):
            raise ValueError("project mode requires profile, project_id, and cwd")
        return self

class IntentEnvelope(BaseModel):
    schema_version: Literal[1] = 1
    intent: MessageIntent = "inform"
    recipients: list[str] = Field(default_factory=list)
    reply_expected: bool = False
    reply_budget: int = Field(default=0, ge=0, le=2)
    correlation_id: str | None = None
    summary: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_reply(self):
        reply_intents = {"reply_required", "handoff", "review_request"}
        if self.intent in reply_intents and (not self.reply_expected or not self.recipients):
            raise ValueError("reply-bearing intents require recipients and reply_expected")
        return self
```

- [ ] **Step 4: Implement migration 1**

Create normalized tables named in the design spec, with foreign keys, indexes on `(channel_id, created_at)`, `(root_message_id, created_at)`, `(state, created_at)`, unique message idempotency keys, and unique session binding `(channel_id, scope_id, profile_id, project_key)`. Store rule snapshots and envelopes as canonical JSON text.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_models.py tests/backend/test_db.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend tests/backend/test_db.py tests/backend/test_models.py
git commit -m "feat: add Crew domain model and database"
```

### Task 3: Persist Channels, Members, Messages, Threads, and Projects

**Files:**
- Create: `src/backend/hermes_crew_backend/repositories.py`
- Create: `src/backend/hermes_crew_backend/project_context.py`
- Create: `tests/backend/test_repositories.py`
- Create: `tests/backend/test_project_context.py`

**Interfaces:**
- Consumes: `CrewDatabase`, `ProjectRef`.
- Produces: `CrewRepository.create_channel`, `add_member`, `append_message`, `get_thread`, `resolve_project_context`.

- [ ] **Step 1: Write failing inheritance and isolation tests**

```python
def test_message_project_becomes_thread_project_without_mutating_channel(repo):
    channel = repo.create_channel("general", default_project=ProjectRef(mode="global"))
    root = repo.append_message(channel.id, "user", "fix login", project=PROJECT_WEB)
    assert resolve_project_context(repo, channel.id, root.id).project_id == "p_web"
    other = repo.append_message(channel.id, "user", "summarize today")
    assert resolve_project_context(repo, channel.id, other.id).mode == "global"

def test_explicit_global_overrides_channel_project(repo):
    channel = repo.create_channel("web", default_project=PROJECT_WEB)
    message = repo.append_message(channel.id, "user", "general question", project=ProjectRef(mode="global"))
    assert resolve_project_context(repo, channel.id, message.id).mode == "global"
```

- [ ] **Step 2: Run tests and confirm missing repository failure**

Run: `pytest tests/backend/test_repositories.py tests/backend/test_project_context.py -q`

Expected: FAIL importing `CrewRepository`.

- [ ] **Step 3: Implement repository transactions**

Implement create/update/list operations with one transaction per command. `append_message` must accept `idempotency_key`, mentions, attachments, `root_message_id`, and optional `ProjectRef`; a duplicate idempotency key returns the original row.

- [ ] **Step 4: Implement exact project precedence**

```python
def resolve_project_context(repo, channel_id: str, message_id: str) -> ProjectRef:
    message = repo.require_message(message_id)
    root = repo.require_message(message.root_message_id) if message.root_message_id else message
    for candidate in (message.project, root.project, repo.require_channel(channel_id).default_project):
        if candidate is not None and candidate.mode != "inherit":
            return candidate
    member_default = repo.member_default_project(message.target_profile) if message.target_profile else None
    return member_default or ProjectRef(mode="global")
```

Compute `project_key` as `global` or `profile:project_id:normalized_cwd`; use the root message id as `scope_id` for every project-overridden top-level message, whether or not the thread drawer has opened.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_repositories.py tests/backend/test_project_context.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/hermes_crew_backend/repositories.py src/backend/hermes_crew_backend/project_context.py tests/backend
git commit -m "feat: persist channels messages and project scopes"
```

### Task 4: Parse Intent Markers and Route Deterministically

**Files:**
- Create: `src/backend/hermes_crew_backend/intent.py`
- Create: `src/backend/hermes_crew_backend/classifier.py`
- Create: `src/backend/hermes_crew_backend/routing.py`
- Create: `tests/backend/test_intent.py`
- Create: `tests/backend/test_classifier.py`
- Create: `tests/backend/test_routing.py`

**Interfaces:**
- Produces: `parse_agent_output(text) -> tuple[str, IntentEnvelope]`; `Classifier.plan(message_id) -> ClassificationClaim | None`; `Router.plan(message_id) -> list[PlannedTurn]`.

- [ ] **Step 1: Write failing parser and routing tests**

```python
def test_marker_is_removed_from_visible_text():
    raw = 'Done.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"inform"} -->'
    visible, envelope = parse_agent_output(raw)
    assert visible == "Done."
    assert envelope.intent == "inform"

def test_agent_inform_does_not_wake_default_responder(router, agent_message):
    assert router.plan(agent_message.id) == []

def test_review_wakes_named_reviewer_once(router, review_message):
    turns = router.plan(review_message.id)
    assert [(t.profile_id, t.trigger) for t in turns] == [("critic", "intent:review_request")]

def test_classifier_is_not_scheduled_when_disabled(classifier, human_message):
    assert classifier.plan(human_message.id) is None
```

- [ ] **Step 2: Verify red state**

Run: `pytest tests/backend/test_intent.py tests/backend/test_routing.py -q`

Expected: FAIL importing parser/router.

- [ ] **Step 3: Implement marker parsing with safe fallback**

Use the final HTML comment matching `<!-- hermes-crew:intent (\{.*\}) -->` with DOTALL disabled and a 4096-byte payload cap. Translate camelCase wire keys to model fields. Multiple markers, invalid JSON, invalid recipients, or schema mismatch return the original visible prose with comments removed and `IntentEnvelope(intent="inform")`.

- [ ] **Step 4: Implement routing precedence and budgets**

Human message candidates: explicit mentions, default responder, other `always` members, then validated enabled-classifier suggestions. Agent message candidates: named recipients from a validated reply-bearing intent only. Collapse by profile id while retaining all trigger reasons. Reject disabled members, exhausted chains, a repeated directed pair over `1`, depth over `2`, total turns over `6`, and channel running count over `4`.

When enabled, `Classifier.plan` creates a `kind="classification"` claim before routing and stores the channel's provider/model/reasoning/max-token snapshot. Its prompt asks for one JSON object with `intent`, `recipients`, and `confidence`; recipients must be enabled channel members. Invalid JSON, confidence below `0.65`, or classifier failure returns no suggestions and preserves the deterministic agent envelope. The worker executes classification through a model-overridden `session.create` followed by stateless `llm.oneshot` using that session id.

- [ ] **Step 5: Add property-style loop tests**

Generate alternating `atlas -> critic -> atlas` review messages and assert the third directed transition yields no plan plus a `loop_blocked` routing decision.

- [ ] **Step 6: Run tests**

Run: `pytest tests/backend/test_intent.py tests/backend/test_classifier.py tests/backend/test_routing.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/hermes_crew_backend/intent.py src/backend/hermes_crew_backend/routing.py tests/backend
git commit -m "feat: add structured intent routing and loop budgets"
```

### Task 5: Assemble Bounded Agent and Classifier Context

**Files:**
- Create: `src/backend/hermes_crew_backend/context_builder.py`
- Create: `tests/backend/test_context_builder.py`

**Interfaces:**
- Consumes: resolved channel, root/thread messages, member, project, trigger, and rule snapshot.
- Produces: `ContextBuilder.for_turn(planned_turn) -> str` and `for_classifier(message) -> tuple[str, str]`.

- [ ] **Step 1: Write failing context tests**

Assert the prompt contains channel purpose, triggering message, complete bounded thread, recent mainline messages, participants, resolved project/cwd, incoming intent, and remaining budgets. Assert it omits `.env` values, messages from unrelated threads, and hidden Hermes prompts.

- [ ] **Step 2: Run red tests**

Run: `pytest tests/backend/test_context_builder.py -q`

Expected: FAIL importing `ContextBuilder`.

- [ ] **Step 3: Implement deterministic context sections**

Use headings `CHANNEL`, `PARTICIPANTS`, `PROJECT`, `TRIGGER`, `THREAD`, `RECENT CHANNEL`, `BUDGET`, and `RESPONSE CONTRACT`. Cap recent mainline at 30 messages, thread at 100 messages, each message at 12,000 characters, and total assembled context at 120,000 characters by removing oldest mainline messages first. End every agent context with this exact contract:

```text
End your final response with exactly one Markdown-hidden comment and no text after it:
<!-- hermes-crew:intent {"schemaVersion":1,"intent":"inform","recipients":[],"replyExpected":false,"replyBudget":0,"correlationId":null,"summary":""} -->
Use inform or result when no reply is needed. Name recipients only when a reply, handoff, or review is required.
```

- [ ] **Step 4: Implement classifier context**

Classifier instructions demand JSON only, list the exact enabled profile ids, describe the eight intents, and state that uncertainty returns `{"intent":"inform","recipients":[],"confidence":0}`.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_context_builder.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/hermes_crew_backend/context_builder.py tests/backend/test_context_builder.py
git commit -m "feat: assemble bounded Crew turn context"
```

### Task 6: Add Scheduler, Activity Journal, Approvals, and Recovery

**Files:**
- Create: `src/backend/hermes_crew_backend/scheduler.py`
- Create: `src/backend/hermes_crew_backend/event_bus.py`
- Create: `tests/backend/test_scheduler.py`
- Create: `tests/backend/test_recovery.py`

**Interfaces:**
- Consumes: `Router`, `Classifier`, and `ContextBuilder` outputs.
- Produces: `Scheduler.claim(worker_id)`, `bind_session`, `record_event`, `complete`, `complete_classification`, `cancel`, `resolve_approval`, `reconcile_startup`.

- [ ] **Step 1: Write failing lifecycle tests**

```python
def test_claim_is_atomic_and_idempotent(scheduler):
    turn = scheduler.enqueue(PLANNED_ATLAS)
    assert scheduler.claim("desktop-a").id == turn.id
    assert scheduler.claim("desktop-b") is None

def test_restart_marks_running_turn_interrupted(scheduler):
    turn = scheduler.enqueue(PLANNED_ATLAS)
    scheduler.claim("desktop-a")
    scheduler.reconcile_startup(active_runtime_ids=set())
    assert scheduler.get(turn.id).state == "interrupted"
    assert scheduler.get(turn.id).retry_of is None
```

- [ ] **Step 2: Verify failures**

Run: `pytest tests/backend/test_scheduler.py tests/backend/test_recovery.py -q`

Expected: FAIL importing `Scheduler`.

- [ ] **Step 3: Implement state machine**

Allow only:

```text
queued -> claimed -> running -> waiting_approval -> running
claimed|running -> completed|failed|cancelled|interrupted
queued -> cancelled
```

Write every transition and normalized gateway event to `activity_events` in the same transaction as turn state. Retry creates a new turn with `retry_of=<old id>` and a new idempotency key; it never resets the old row.

- [ ] **Step 4: Implement event bus and polling cursor**

Publish `{sequence, type, channelId, turnId, payload}` frames. WebSocket subscribers receive frames immediately; `GET /events?after=<sequence>` returns the same ordered frames for polling fallback.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_scheduler.py tests/backend/test_recovery.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/hermes_crew_backend/scheduler.py src/backend/hermes_crew_backend/event_bus.py tests/backend
git commit -m "feat: add durable turn scheduling and recovery"
```

### Task 7: Expose the Scoped FastAPI Plugin Backend

**Files:**
- Create: `src/backend/hermes_crew_backend/api.py`
- Create: `plugin/plugin.yaml`
- Create: `plugin/__init__.py`
- Create: `plugin/dashboard/manifest.json`
- Create: `plugin/dashboard/plugin_api.py`
- Create: `tests/backend/test_api.py`

**Interfaces:**
- Produces: REST/WebSocket API under `/api/plugins/hermes-crew`.

- [ ] **Step 1: Write failing API tests**

Test `GET /health`, channel CRUD, idempotent message creation, thread retrieval, dispatch claim/bind/event/complete, cancel, approval resolve, activity cursor, and WebSocket event delivery using `TestClient`.

- [ ] **Step 2: Run red tests**

Run: `pytest tests/backend/test_api.py -q`

Expected: FAIL importing `router`.

- [ ] **Step 3: Implement exact route surface**

```text
GET    /health
GET    /channels
POST   /channels
PATCH  /channels/{channel_id}
GET    /channels/{channel_id}/messages
POST   /channels/{channel_id}/messages
GET    /threads/{root_message_id}
POST   /dispatch/claim
POST   /dispatch/{turn_id}/session
POST   /dispatch/{turn_id}/events
POST   /dispatch/{turn_id}/complete
POST   /dispatch/{turn_id}/classification
POST   /turns/{turn_id}/cancel
POST   /turns/{turn_id}/retry
POST   /approvals/{approval_id}/resolve
GET    /activity
GET    /events
WS     /events
```

Return validation errors as `{code, message, fieldErrors}` and conflicts as HTTP 409.

- [ ] **Step 4: Add loader artifacts**

`manifest.json` declares name `hermes-crew`, label `Hermes Crew`, `api: plugin_api.py`, and no dashboard JS entry. `plugin_api.py` adds its own directory to `sys.path` and imports `router` from `hermes_crew_backend.api`. `plugin.yaml` uses name `hermes-crew`, version `0.1.0`, and description `Local multi-profile channels for Hermes Desktop`. `plugin/__init__.py` contains `def register(ctx): return None`, allowing `hermes plugins enable hermes-crew` to authorize backend loading without adding agent tools or hooks.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_api.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/hermes_crew_backend/api.py plugin tests/backend/test_api.py
git commit -m "feat: expose Crew coordination API"
```

### Task 8: Bridge Hermes Profiles, Models, Skills, Tools, and Projects

**Files:**
- Create: `src/backend/hermes_crew_backend/hermes_adapter.py`
- Create: `tests/backend/test_hermes_adapter.py`
- Modify: `src/backend/hermes_crew_backend/api.py`

**Interfaces:**
- Produces: `HermesAdapter.list_profiles`, `create_profile`, `read/write_soul`, `set_model`, `list/toggle_skills`, `list/toggle_toolsets`, `list_projects`, `validate_project`.

- [ ] **Step 1: Write failing adapter tests with temporary Hermes homes**

Verify default/named profile listing, `create_profile(no_skills=True)`, atomic SOUL replacement, model config writes to the target profile only, per-profile skill toggles, and project validation by stable id plus primary cwd.

- [ ] **Step 2: Run red tests**

Run: `pytest tests/backend/test_hermes_adapter.py -q`

Expected: FAIL importing `HermesAdapter`.

- [ ] **Step 3: Implement adapter using Hermes public modules**

Use `hermes_cli.profiles.list_profiles/create_profile/rename_profile/delete_profile/write_profile_meta`, `hermes_constants.set_hermes_home_override`, `hermes_cli.config.load_config/save_config`, and `hermes_cli.projects_db.connect/list_projects/get_project`. Write SOUL through `utils.atomic_write_text(..., preserve_mode=True, create_mode=0o644)`. Model configuration writes:

```python
cfg["model"] = {
    **(cfg.get("model") if isinstance(cfg.get("model"), dict) else {}),
    "provider": provider.strip(),
    "default": model.strip(),
}
cfg["model"].pop("base_url", None)
cfg["model"].pop("context_length", None)
```

Never read or return `.env` values; expose booleans such as `has_env` and provider readiness only.

- [ ] **Step 4: Add Studio/project endpoints**

```text
GET/POST        /profiles
GET/PATCH       /profiles/{name}
GET/PUT         /profiles/{name}/soul
PUT             /profiles/{name}/model
GET/PUT         /profiles/{name}/skills
GET/PUT         /profiles/{name}/toolsets
GET             /projects?profile={name}
POST            /projects/validate
```

Profile delete is not exposed in v1; archive the Crew member and deep-link to native Hermes profile management for destructive deletion.

- [ ] **Step 5: Run tests**

Run: `pytest tests/backend/test_hermes_adapter.py tests/backend/test_api.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/hermes_crew_backend tests/backend
git commit -m "feat: integrate Hermes profiles and projects"
```

### Task 9: Build the Desktop Plugin Shell and API Client

**Files:**
- Create: `src/desktop/sdk.d.ts`
- Create: `src/desktop/types.ts`
- Create: `src/desktop/api.ts`
- Create: `src/desktop/state.ts`
- Create: `src/desktop/plugin.tsx`
- Create: `src/desktop/views/crew-page.tsx`
- Create: `tests/desktop/plugin.test.tsx`
- Create: `scripts/build.mjs`

**Interfaces:**
- Consumes: scoped backend routes.
- Produces: default `HermesPlugin` id `hermes-crew`; `CrewApi`; `/crew` route and sidebar item.

- [ ] **Step 1: Write failing registration test**

Mock the SDK and assert the plugin registers route `{path:'/crew'}`, sidebar navigation labeled `Crew`, palette command `Open Hermes Crew`, and unload cleanup.

- [ ] **Step 2: Verify red state**

Run: `npm test -- tests/desktop/plugin.test.tsx`

Expected: FAIL importing `plugin.tsx`.

- [ ] **Step 3: Implement narrow SDK declarations and API client**

Declare only used SDK exports. `CrewApi` accepts `ctx.rest`; every mutation passes JSON bodies and a 30-second timeout. React Query keys begin with `['hermes-crew', ...]`.

- [ ] **Step 4: Register the shell**

```tsx
export default {
  id: 'hermes-crew',
  name: 'Hermes Crew',
  description: 'Persistent Hermes profiles working together in local channels.',
  register(ctx) {
    const api = new CrewApi(ctx.rest)
    ctx.registerMany([
      { id: 'route', area: ROUTES_AREA, path: '/crew', render: () => <CrewPage api={api} /> },
      { id: 'nav', area: SIDEBAR_NAV_AREA, label: 'Crew', path: '/crew', icon: icons.Users },
      { id: 'open', area: PALETTE_AREA, label: 'Open Hermes Crew', run: () => host.navigate('/crew') }
    ])
  }
} satisfies HermesPlugin
```

- [ ] **Step 5: Bundle with SDK externals**

`build.mjs` bundles `src/desktop/plugin.tsx` to `dist/desktop-plugins/hermes-crew/plugin.js`, uses JSX automatic transform, format ESM, target ES2022, and externalizes the three permitted imports.

- [ ] **Step 6: Run checks**

Run: `npm test -- tests/desktop/plugin.test.tsx && npm run typecheck && npm run build`

Expected: PASS and exactly one desktop JS artifact.

- [ ] **Step 7: Commit**

```bash
git add src/desktop tests/desktop scripts/build.mjs
git commit -m "feat: add native Hermes Crew plugin shell"
```

### Task 10: Implement the Always-Loaded Gateway Dispatch Worker

**Files:**
- Create: `src/desktop/gateway-worker.ts`
- Create: `src/desktop/event-normalizer.ts`
- Create: `src/desktop/intent-marker.ts`
- Create: `tests/desktop/gateway-worker.test.ts`
- Create: `tests/desktop/event-normalizer.test.ts`
- Modify: `src/desktop/plugin.tsx`

**Interfaces:**
- Consumes: `DispatchClaim` and Hermes RPC/event contracts.
- Produces: bound runtime sessions, normalized activity, completed responses and intents.

- [ ] **Step 1: Write failing dispatch test**

Assert one claim produces these exact calls in order:

```ts
['session.create', {
  cols: 96, source: 'desktop', cwd: '/work/web', profile: 'atlas',
  model: 'gpt-5.6', provider: 'openai', reasoning_effort: 'high', fast: false
}]
['prompt.submit', {session_id: 'runtime-1', text: claim.context}]
```

Assert `message.complete` for another session id is ignored and `session.interrupt` targets only the cancelled turn.

Also assert a `kind="classification"` claim calls model-overridden `session.create`, then `llm.oneshot` with `{session_id, instructions, input, task:'hermes_crew_classifier', max_tokens:300, temperature:0}`, and posts the returned JSON to `/dispatch/{turnId}/classification` without calling `prompt.submit`.

- [ ] **Step 2: Run red tests**

Run: `npm test -- tests/desktop/gateway-worker.test.ts tests/desktop/event-normalizer.test.ts`

Expected: FAIL importing worker/normalizer.

- [ ] **Step 3: Implement worker lifecycle**

Start the worker from `register()`, not from `CrewPage`. Claim with a stable per-window worker id every two seconds; pause when `host.state.gateway` is not `open`. After `session.create`, POST both runtime and stored ids to `/dispatch/{turn}/session`, register `runtimeSessionId -> turnId`, submit context, and forward matched events in batches of at most 50 or every 100ms.

- [ ] **Step 4: Correlate completion and hidden intent**

Buffer assistant deltas per turn. Markdown hides the exact final marker:

```text
<!-- hermes-crew:intent {"schemaVersion":1,"intent":"inform"} -->
```

On `message.complete`, strip and parse it, POST visible text plus envelope to `/dispatch/{turn}/complete`, then remove the session map. Invalid output posts `intent: inform`.

- [ ] **Step 5: Add socket acceleration and polling fallback**

Use `ctx.socket('/events', invalidate)` to wake claim/cancel handling. Keep the two-second claim and activity polling path because OAuth remote mode may make sockets a no-op.

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/desktop/gateway-worker.test.ts tests/desktop/event-normalizer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/desktop tests/desktop
git commit -m "feat: bridge Crew dispatches to Hermes sessions"
```

### Task 11: Build Channels, Composer, Mentions, Projects, and Threads

**Files:**
- Create: `src/desktop/views/channel-view.tsx`
- Create: `src/desktop/views/thread-view.tsx`
- Create: `src/desktop/components/channel-list.tsx`
- Create: `src/desktop/components/member-roster.tsx`
- Create: `src/desktop/components/message-list.tsx`
- Create: `src/desktop/components/crew-composer.tsx`
- Create: `src/desktop/components/project-picker.tsx`
- Create: `tests/desktop/channel-flow.test.tsx`

**Interfaces:**
- Consumes: channel/message/thread/profile/project APIs.
- Produces: human message commands with explicit mentions and `ProjectRef`.

- [ ] **Step 1: Write failing user-flow tests**

Test channel creation, selecting default responder, `@atlas` mention chips, human `@all`, project picker choices `inherit/global/project`, opening a thread, and an ad-hoc project message that leaves the next top-level composer on `inherit`.

- [ ] **Step 2: Verify red state**

Run: `npm test -- tests/desktop/channel-flow.test.tsx`

Expected: FAIL because channel components do not exist.

- [ ] **Step 3: Implement three-column Crew page**

Left: channel list and roster. Center: header, virtual-safe message list, composer. Right: members, resolved project, running turns, budget, pins, and artifacts. On narrow viewports, right content opens as a pane/drawer and channel list becomes an overlay.

- [ ] **Step 4: Implement composer payload**

```ts
{
  content,
  idempotencyKey: crypto.randomUUID(),
  mentions: selectedMembers.map(m => m.profileId),
  rootMessageId: activeThreadRoot,
  project: selectedProject,
  attachments: attachmentRefs
}
```

Clear content only after backend acknowledgment; retain failed drafts. A project selection on a top-level message resets to `inherit` after success, while the thread composer displays and retains the root's resolved project.

- [ ] **Step 5: Render inspectable message metadata**

Show author, role, timestamp, project chip, model label, status, reply count, and actions for reply, stop, retry, copy, and inspect. Do not render raw intent comments.

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/desktop/channel-flow.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/desktop tests/desktop/channel-flow.test.tsx
git commit -m "feat: add project-aware channels and threads"
```

### Task 12: Render Live Activity, Results, Approvals, and Controls

**Files:**
- Create: `src/desktop/components/activity-panel.tsx`
- Create: `src/desktop/components/tool-activity.tsx`
- Create: `src/desktop/components/result-card.tsx`
- Create: `src/desktop/components/approval-card.tsx`
- Create: `tests/desktop/activity.test.tsx`

**Interfaces:**
- Consumes: normalized activity and control endpoints.
- Produces: accessible live states and scoped stop/retry/approval actions.

- [ ] **Step 1: Write failing rendering/control tests**

Test `queued`, `streaming`, `tool_started`, `waiting_approval`, `completed`, `failed`, `cancelled`, and `interrupted`; ensure stopping Atlas sends only Atlas's turn id; ensure approval reject does not create a child turn.

- [ ] **Step 2: Run red tests**

Run: `npm test -- tests/desktop/activity.test.tsx`

Expected: FAIL importing activity components.

- [ ] **Step 3: Implement activity and result presentation**

Group tool progress beneath its turn and collapse completed tools by default. Result cards display disposition, summary, artifacts, changed files, verification commands/outcomes, blockers, and routing explanation. Unknown payload keys remain inspectable as formatted JSON but never become HTML.

- [ ] **Step 4: Implement controls**

Stop posts `/turns/{id}/cancel`; retry posts `/turns/{id}/retry`; approval posts `{decision:'approve'|'reject', note}`. Disable buttons after acknowledgment and announce state changes through an `aria-live="polite"` region.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/desktop/activity.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/desktop tests/desktop/activity.test.tsx
git commit -m "feat: surface Crew activity results and approvals"
```

### Task 13: Implement Crew Studio and Independent Agent Models

**Files:**
- Create: `src/desktop/views/studio-view.tsx`
- Create: `src/desktop/components/profile-editor.tsx`
- Create: `src/desktop/components/model-editor.tsx`
- Create: `src/desktop/components/capability-editor.tsx`
- Create: `src/desktop/components/behavior-editor.tsx`
- Create: `src/desktop/components/readiness-card.tsx`
- Create: `tests/desktop/studio.test.tsx`

**Interfaces:**
- Consumes: profile/Studio endpoints and Hermes `model.options`/`evaluateRuntimeReadiness`.
- Produces: profile-backed Crew member configuration.

- [ ] **Step 1: Write failing Studio tests**

Cover select/create profile, identity edit, SOUL save, Atlas on OpenAI model, Scout on Gemini, skill/tool toggles, default/allowed projects, per-channel activation, reply budgets, classifier off, and readiness failure without leaking credential values.

- [ ] **Step 2: Run red tests**

Run: `npm test -- tests/desktop/studio.test.tsx`

Expected: FAIL importing Studio.

- [ ] **Step 3: Implement master-detail sections**

Use sections Identity, Brain, Capabilities, Workspace, Behavior, Permissions, Knowledge, Diagnostics. Save each section independently with dirty-state protection. Use `ModelCatalogMenu` for model selection and native Hermes components for all controls.

- [ ] **Step 4: Implement creation flow**

Create/select profile, identity/role, provider/model, SOUL, skills/tools, project access, channel membership, readiness. `no_skills` and clone options are mutually exclusive in UI and API. A partial post-create failure leaves the profile visible with a diagnostic action rather than deleting it.

- [ ] **Step 5: Add native deep links**

Use `host.navigate` for existing Hermes Profiles, Skills, Projects, Sessions, and Settings views. Keep Crew-specific role, membership, behavior, classifier, and routing fields inside Studio.

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/desktop/studio.test.tsx && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/desktop tests/desktop/studio.test.tsx
git commit -m "feat: add Crew Studio for profile-backed agents"
```

### Task 14: Add First Run, Search, Installation, and Distribution

**Files:**
- Create: `src/desktop/components/first-run.tsx`
- Create: `src/desktop/components/search-view.tsx`
- Create: `scripts/install.py`
- Create: `scripts/package.mjs`
- Create: `scripts/verify-dist.mjs`
- Create: `tests/integration/test_install.py`
- Create: `tests/desktop/first-run.test.tsx`
- Create: `README.md`

**Interfaces:**
- Produces: installable archive and idempotent owner-profile installation.

- [ ] **Step 1: Write failing first-run and installer tests**

Use a temporary `HERMES_HOME`; install twice and assert one desktop plugin, one enabled backend plugin, preserved `crew/crew.db`, and no writes into named member profiles. Test first run creates `#general`, global context, one selected default responder, and classifier disabled.

- [ ] **Step 2: Run red tests**

Run: `pytest tests/integration/test_install.py -q && npm test -- tests/desktop/first-run.test.tsx`

Expected: FAIL because installer and first-run UI do not exist.

- [ ] **Step 3: Implement owner-profile installer**

Copy generated `plugin.js` to `$HERMES_HOME/desktop-plugins/hermes-crew/plugin.js`; copy backend package, manifest, `plugin.yaml`, and loader to `$HERMES_HOME/plugins/hermes-crew`; atomically add `hermes-crew` to `plugins.enabled` while preserving all unrelated config. Store the database at `$HERMES_HOME/crew/crew.db`. Print exact restart/reload instructions. `--uninstall` removes installed code but preserves `$HERMES_HOME/crew` unless `--purge-data` is explicitly passed.

- [ ] **Step 4: Implement search and first run**

Search filters messages/activity by channel, member, project, state, and text using SQLite FTS5. First run appears only when there are no channels and completes in one transaction.

- [ ] **Step 5: Implement artifact verification**

`verify-dist.mjs` fails if `plugin.js` imports anything beyond the three allowed specifiers, contains source maps with absolute paths, or if packaged files contain patterns matching API-key assignments. `package.mjs` creates `hermes-crew-0.1.0.tar.gz` with SHA-256 manifest.

- [ ] **Step 6: Document exact install and recovery paths**

README covers prerequisites, build, install, enable/reload, owner-profile concept, project scoping, permissions warning, database backup, logs, upgrade, uninstall, and the Hermes 0.17.0 floor.

- [ ] **Step 7: Run tests**

Run: `npm run build && npm run verify:dist && pytest tests/integration/test_install.py -q && npm test -- tests/desktop/first-run.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/desktop scripts tests README.md
git commit -m "feat: package and onboard Hermes Crew"
```

### Task 15: Prove End-to-End Acceptance and Cut v0.1.0

**Files:**
- Create: `tests/integration/fake_hermes.py`
- Create: `tests/integration/test_multi_agent_flow.py`
- Create: `tests/e2e/crew.spec.ts`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `pyproject.toml`

**Interfaces:**
- Consumes: the complete application.
- Produces: reproducible v0.1.0 release evidence.

- [ ] **Step 1: Write end-to-end scenarios before fixes**

The fake gateway must implement the verified RPC/event contract and record calls. Cover:

1. Atlas/GPT default response plus explicitly mentioned Scout/Gemini response.
2. Inform result with zero child turns.
3. One Atlas-to-Critic review handoff.
4. Forced Critic-to-Atlas loop blocked at the configured pair/depth boundary.
5. Dedicated project channel using `/work/hermes`.
6. General-channel message using `/work/web` whose thread stays on web while the next top-level message is global.
7. Stop Atlas while Scout completes.
8. Approval reject.
9. Desktop/backend restart with running work marked interrupted and no duplicate submit.
10. Missing project/profile/model readiness errors.

- [ ] **Step 2: Run the full suite and capture failures**

Run: `pytest -q && npm test && npm run typecheck && npm run build && npm run verify:dist`

Expected before final fixes: scenario-specific failures only; no skipped acceptance scenarios.

- [ ] **Step 3: Fix each scenario at its owning boundary**

Routing defects go in `routing.py`; persistence/recovery in `scheduler.py`; Hermes calls in `gateway-worker.ts`/`hermes_adapter.py`; rendering defects in the relevant component. Do not add test-only branches to production code.

- [ ] **Step 4: Run real Hermes smoke test**

Against Hermes Desktop 0.17.0 in a disposable `HERMES_HOME`, install Crew, create two no-skill profiles, assign two configured test models, send one global and one project-bound message, inspect streams, stop one turn, restart Desktop, and verify the ten scenario outcomes in the activity journal. Record the Hermes version, OS, plugin SHA-256, and database schema version in `CHANGELOG.md`.

- [ ] **Step 5: Run final release gate**

Run: `pytest -q && npm test && npm run typecheck && npm run build && npm run verify:dist && node scripts/package.mjs`

Expected: all tests PASS, no skips in acceptance suites, archive and checksum emitted.

- [ ] **Step 6: Commit and tag**

```bash
git add tests CHANGELOG.md package.json pyproject.toml
git commit -m "test: verify Hermes Crew v1 acceptance flows"
git tag -a v0.1.0 -m "Hermes Crew v0.1.0"
```

## Plan Verification Checklist

- Every requirement in the approved design maps to at least one task and an acceptance scenario.
- Frontend/backend execution ownership matches the actual Hermes SDK boundary.
- Profile-specific model and project context flow into exact `session.create` parameters.
- Message-level project context creates a root-scoped session binding without changing the channel default.
- Agent messages cannot trigger `always` responders without a valid named reply intent.
- Invalid metadata is non-triggering.
- Classifier code is optional and off by default.
- Destructive profile deletion remains in native Hermes management.
- Installation preserves Crew data by default.
- No step relies on an undefined function, type, route, RPC, or event.
