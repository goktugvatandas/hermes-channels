"""Durable turn scheduling, lifecycle transitions, and restart recovery."""

from dataclasses import dataclass
import json
import logging
import sqlite3
import time
from typing import Any, Literal
from uuid import uuid4

from .classifier import Classifier
from .context_builder import ContextBuilder
from .event_bus import EventBus, EventFrame
from .models import DispatchClaim, IntentEnvelope
from .project_context import project_key, resolve_project_context, resolve_scope_id
from .intent import parse_agent_output
from .session_visibility import archive_stored_session, read_completed_response
from .repositories import CrewRepository
from .routing import PlannedTurn, Router


_log = logging.getLogger(__name__)


TurnState = Literal[
    "queued",
    "claimed",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
]

TERMINAL_STATES = {"completed", "failed", "cancelled", "interrupted"}
# In-flight turns whose worker has neither journaled nor heartbeat for this
# long are considered orphaned (the worker died without a terminal
# transition). Workers beat every ~60s, so this tolerates several misses.
STALE_TURN_MS = 5 * 60 * 1000
TRANSITIONS: dict[str, set[str]] = {
    "queued": {"claimed", "cancelled"},
    "claimed": {"running", "completed", "failed", "cancelled", "interrupted"},
    "running": {"waiting_approval", "completed", "failed", "cancelled", "interrupted"},
    "waiting_approval": {"running", "cancelled", "failed", "interrupted"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
    "interrupted": set(),
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True, slots=True)
class TurnRecord:
    id: str
    channel_id: str
    trigger_message_id: str
    root_message_id: str | None
    parent_turn_id: str | None
    profile_id: str | None
    kind: str
    trigger: str
    state: str
    depth: int
    idempotency_key: str
    context: str
    provider: str | None
    model: str | None
    reasoning_effort: str | None
    cwd: str | None
    worker_id: str | None
    runtime_session_id: str | None
    stored_session_id: str | None
    result_message_id: str | None
    retry_of: str | None
    created_at: int
    updated_at: int


@dataclass(frozen=True, slots=True)
class ApprovalRecord:
    id: str
    turn_id: str
    request_id: str
    state: str
    payload: dict[str, Any]
    decision: str | None
    note: str | None


class Scheduler:
    def __init__(
        self,
        repository: CrewRepository,
        *,
        router: Router | None = None,
        classifier: Classifier | None = None,
        context_builder: ContextBuilder | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.repository = repository
        self.router = router or Router(repository)
        self.classifier = classifier or Classifier(repository)
        self.context_builder = context_builder or ContextBuilder(repository)
        self.event_bus = event_bus or EventBus()

    def enqueue(self, planned: PlannedTurn) -> TurnRecord:
        message = self.repository.require_message(planned.message_id)
        context = self.context_builder.for_turn(planned)
        project = resolve_project_context(
            self.repository,
            planned.channel_id,
            planned.message_id,
            target_profile=planned.profile_id,
        )
        idempotency_key = f"agent:{planned.message_id}:{planned.profile_id}"
        now = _now_ms()
        turn_id = uuid4().hex
        frame: EventFrame | None = None
        with self.repository.database.connect() as connection:
            # Write lock up front: turn scheduling must dedupe, not 409, when
            # a retried message lands concurrently with the original.
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM turns WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if existing is not None:
                return self._turn(existing)
            connection.execute(
                """INSERT INTO turns (
                       id, channel_id, trigger_message_id, root_message_id,
                       profile_id, kind, trigger, state, depth, idempotency_key,
                       context, project_json, rule_snapshot_json, cwd,
                       created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'agent', ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    turn_id,
                    planned.channel_id,
                    planned.message_id,
                    message.root_message_id
                    or (message.id if message.project is not None else None),
                    planned.profile_id,
                    planned.trigger,
                    planned.depth,
                    idempotency_key,
                    context,
                    _canonical(project.model_dump(mode="json", by_alias=True)),
                    _canonical(planned.rule_snapshot),
                    project.cwd,
                    now,
                    now,
                ),
            )
            frame = self._insert_event(
                connection,
                planned.channel_id,
                turn_id,
                "queued",
                {
                    "profileId": planned.profile_id,
                    "reasons": list(planned.triggers),
                    # Lets activity surfaces show which message a turn answers.
                    "triggerMessageId": planned.message_id,
                    "triggerExcerpt": message.content[:160],
                },
                now,
            )
            row = connection.execute(
                "SELECT * FROM turns WHERE id = ?", (turn_id,)
            ).fetchone()
        assert row is not None and frame is not None
        self.event_bus.publish(frame)
        return self._turn(row)

    def claim(self, worker_id: str) -> DispatchClaim | None:
        # Workers poll claim continuously; piggyback the stale-turn reap here
        # so orphans get cleaned within minutes even without a backend restart.
        self.reconcile_startup(set())
        now = _now_ms()
        frame: EventFrame | None = None
        with self.repository.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM turns WHERE state = 'queued' ORDER BY created_at, id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            updated = connection.execute(
                """UPDATE turns SET state = 'claimed', worker_id = ?, claimed_at = ?,
                       updated_at = ? WHERE id = ? AND state = 'queued'""",
                (worker_id, now, now, row["id"]),
            )
            if updated.rowcount != 1:
                return None
            frame = self._insert_event(
                connection,
                row["channel_id"],
                row["id"],
                "claimed",
                {"workerId": worker_id},
                now,
            )
            claimed = connection.execute(
                "SELECT * FROM turns WHERE id = ?", (row["id"],)
            ).fetchone()
        assert claimed is not None and frame is not None
        self.event_bus.publish(frame)
        return self._claim_from_row(claimed)

    def bind_session(
        self,
        turn_id: str,
        *,
        runtime_session_id: str,
        stored_session_id: str | None = None,
    ) -> TurnRecord:
        turn = self.get(turn_id)
        message = self.repository.require_message(turn.trigger_message_id)
        project = resolve_project_context(
            self.repository,
            turn.channel_id,
            turn.trigger_message_id,
            target_profile=turn.profile_id,
        )
        scope_id = resolve_scope_id(
            self.repository, turn.channel_id, turn.trigger_message_id
        )
        now = _now_ms()
        with self.repository.database.connect() as connection:
            self._require_transition(turn.state, "running")
            connection.execute(
                """UPDATE turns SET state = 'running', runtime_session_id = ?,
                       stored_session_id = ?, started_at = ?, updated_at = ?
                   WHERE id = ?""",
                (runtime_session_id, stored_session_id, now, now, turn_id),
            )
            connection.execute(
                """INSERT INTO session_bindings (
                       id, channel_id, scope_id, profile_id, project_key,
                       stored_session_id, runtime_session_id, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(channel_id, scope_id, profile_id, project_key) DO UPDATE SET
                       stored_session_id = excluded.stored_session_id,
                       runtime_session_id = excluded.runtime_session_id,
                       updated_at = excluded.updated_at""",
                (
                    uuid4().hex,
                    turn.channel_id,
                    scope_id,
                    turn.profile_id or "classifier",
                    project_key(project),
                    stored_session_id,
                    runtime_session_id,
                    now,
                    now,
                ),
            )
            frame = self._insert_event(
                connection,
                turn.channel_id,
                turn_id,
                "started",
                {
                    "runtimeSessionId": runtime_session_id,
                    "storedSessionId": stored_session_id,
                },
                now,
            )
        self.event_bus.publish(frame)
        return self.get(turn_id)

    def record_event(
        self, turn_id: str, event_type: str, payload: dict[str, Any]
    ) -> ApprovalRecord | EventFrame:
        turn = self.get(turn_id)
        now = _now_ms()
        approval: ApprovalRecord | None = None
        with self.repository.database.connect() as connection:
            if event_type == "approval_request":
                self._require_transition(turn.state, "waiting_approval")
                request_id = payload.get("requestId")
                if not isinstance(request_id, str) or not request_id:
                    raise ValueError("approval_request requires requestId")
                approval_id = uuid4().hex
                connection.execute(
                    """INSERT INTO approvals
                       (id, turn_id, request_id, state, payload_json, created_at)
                       VALUES (?, ?, ?, 'pending', ?, ?)""",
                    (approval_id, turn_id, request_id, _canonical(payload), now),
                )
                connection.execute(
                    "UPDATE turns SET state = 'waiting_approval', updated_at = ? WHERE id = ?",
                    (now, turn_id),
                )
                approval = ApprovalRecord(
                    approval_id,
                    turn_id,
                    request_id,
                    "pending",
                    payload,
                    None,
                    None,
                )
                journal_type = "waiting_approval"
                journal_payload = {**payload, "approvalId": approval_id}
            else:
                journal_type = event_type
                journal_payload = payload
            frame = self._insert_event(
                connection,
                turn.channel_id,
                turn_id,
                journal_type,
                journal_payload,
                now,
            )
        self.event_bus.publish(frame)
        return approval or frame

    def complete(
        self,
        turn_id: str,
        *,
        visible_text: str,
        envelope: IntentEnvelope,
        source: str = "desktop",
    ) -> TurnRecord:
        turn = self.get(turn_id)
        # The host-owned post_llm_call hook and the Desktop gateway-event bridge
        # intentionally race to finalize the same channel turn. Completion is an
        # idempotent fact: once a durable result exists, later observers must
        # acknowledge it rather than turn a successful delivery into an error.
        if turn.state == "completed" and turn.result_message_id:
            return turn
        self._require_transition(turn.state, "completed")
        trigger = self.repository.require_message(turn.trigger_message_id)
        # Placement: auto answers where the question was asked; thread starts
        # or continues a thread under the trigger; channel posts to the
        # timeline even when triggered from a thread.
        if envelope.placement == "thread":
            result_root = trigger.root_message_id or trigger.id
        elif envelope.placement == "channel":
            result_root = None
        else:
            result_root = trigger.root_message_id
        # Message-scoped project context must survive across relays no matter
        # where the answer is placed: carry the trigger's message scope (or
        # its thread root's) onto the result. parent_message_id records the
        # causal link that session scoping and budgets walk.
        trigger_root = (
            self.repository.require_message(trigger.root_message_id)
            if trigger.root_message_id
            else None
        )
        inherited_project = trigger.project or (trigger_root.project if trigger_root else None)
        result = self.repository.append_message(
            turn.channel_id,
            "agent",
            visible_text,
            idempotency_key=f"result:{turn_id}",
            root_message_id=result_root,
            parent_message_id=trigger.id,
            project=inherited_project,
            author_profile_id=turn.profile_id,
            intent_envelope=envelope.model_dump(mode="json", by_alias=True),
            model_label=turn.model,
        )
        now = _now_ms()
        with self.repository.database.connect() as connection:
            updated = connection.execute(
                """UPDATE turns SET state = 'completed', result_message_id = ?,
                       completed_at = ?, updated_at = ?
                   WHERE id = ? AND state = ?""",
                (result.id, now, now, turn_id, turn.state),
            )
            if updated.rowcount != 1:
                current = connection.execute(
                    "SELECT * FROM turns WHERE id = ?", (turn_id,)
                ).fetchone()
                if (
                    current is not None
                    and current["state"] == "completed"
                    and current["result_message_id"]
                ):
                    return self._turn(current)
                if current is None:
                    raise KeyError(f"unknown turn: {turn_id}")
                self._require_transition(current["state"], "completed")
                raise RuntimeError(f"turn {turn_id} changed during completion")
            frame = self._insert_event(
                connection,
                turn.channel_id,
                turn_id,
                "completed",
                {"messageId": result.id, "intent": envelope.intent, "source": source},
                now,
            )
        self.event_bus.publish(frame)
        self._archive_turn_session(turn)
        for planned in self.router.plan(result.id):
            self.enqueue(planned)
        return self.get(turn_id)

    def complete_classification(self, turn_id: str, raw_result: str) -> list[TurnRecord]:
        turn = self.get(turn_id)
        if turn.kind != "classification":
            raise ValueError("turn is not a classification claim")
        suggestion = self.classifier.parse_result(raw_result, turn.channel_id)
        now = _now_ms()
        with self.repository.database.connect() as connection:
            self._require_transition(turn.state, "completed")
            connection.execute(
                """UPDATE turns SET state = 'completed', completed_at = ?, updated_at = ?
                   WHERE id = ?""",
                (now, now, turn_id),
            )
            frame = self._insert_event(
                connection,
                turn.channel_id,
                turn_id,
                "completed",
                {"classificationAccepted": suggestion is not None},
                now,
            )
        self.event_bus.publish(frame)
        self._archive_turn_session(turn)
        return [
            self.enqueue(planned)
            for planned in self.router.plan(turn.trigger_message_id, suggestion)
        ]

    def cancel(self, turn_id: str) -> TurnRecord:
        turn = self.get(turn_id)
        return self._terminal_transition(turn, "cancelled", {})

    def fail(self, turn_id: str, error: str) -> TurnRecord:
        turn = self.get(turn_id)
        return self._terminal_transition(turn, "failed", {"error": error}, error=error)

    def retry(self, turn_id: str) -> TurnRecord:
        old = self.get(turn_id)
        if old.state not in TERMINAL_STATES:
            raise ValueError("only terminal turns can be retried")
        new_id = uuid4().hex
        now = _now_ms()
        idempotency_key = f"retry:{turn_id}:{new_id}"
        with self.repository.database.connect() as connection:
            connection.execute(
                """INSERT INTO turns (
                       id, channel_id, trigger_message_id, root_message_id,
                       parent_turn_id, profile_id, kind, trigger, state, depth,
                       idempotency_key, context, project_json, rule_snapshot_json,
                       provider, model, reasoning_effort, cwd, retry_of,
                       created_at, updated_at
                   ) SELECT ?, channel_id, trigger_message_id, root_message_id,
                       parent_turn_id, profile_id, kind, trigger, 'queued', depth,
                       ?, context, project_json, rule_snapshot_json,
                       provider, model, reasoning_effort, cwd, ?, ?, ?
                   FROM turns WHERE id = ?""",
                (new_id, idempotency_key, turn_id, now, now, turn_id),
            )
            frame = self._insert_event(
                connection,
                old.channel_id,
                new_id,
                "queued",
                {"retryOf": turn_id},
                now,
            )
        self.event_bus.publish(frame)
        return self.get(new_id)

    def resolve_approval(
        self, approval_id: str, *, decision: str, note: str = ""
    ) -> ApprovalRecord:
        if decision not in {"approve", "reject"}:
            raise ValueError("decision must be approve or reject")
        now = _now_ms()
        with self.repository.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"unknown approval: {approval_id}")
            if row["state"] != "pending":
                raise ValueError("approval is already resolved")
            turn = connection.execute(
                "SELECT * FROM turns WHERE id = ?", (row["turn_id"],)
            ).fetchone()
            assert turn is not None
            self._require_transition(turn["state"], "running")
            connection.execute(
                """UPDATE approvals SET state = 'resolved', decision = ?, note = ?,
                       resolved_at = ? WHERE id = ?""",
                (decision, note, now, approval_id),
            )
            connection.execute(
                "UPDATE turns SET state = 'running', updated_at = ? WHERE id = ?",
                (now, row["turn_id"]),
            )
            payload = json.loads(row["payload_json"])
            frame = self._insert_event(
                connection,
                turn["channel_id"],
                row["turn_id"],
                "approval_resolved",
                {"approvalId": approval_id, "decision": decision, "note": note},
                now,
            )
        self.event_bus.publish(frame)
        return ApprovalRecord(
            approval_id,
            row["turn_id"],
            row["request_id"],
            "resolved",
            payload,
            decision,
            note,
        )

    def _recover_persisted_completion(self, turn: TurnRecord) -> bool:
        """Finalize a response that reached the profile transcript before a crash."""

        response = read_completed_response(
            turn.profile_id,
            turn.stored_session_id,
            not_before_ms=turn.created_at,
        )
        if not response:
            return False
        visible_text, envelope = parse_agent_output(response)
        if not visible_text:
            return False
        try:
            self.complete(
                turn.id,
                visible_text=visible_text,
                envelope=envelope,
                source="transcript_recovery",
            )
            return True
        except Exception:
            _log.warning(
                "could not recover persisted channel response for turn %s",
                turn.id,
                exc_info=True,
            )
            return False

    def reconcile_startup(
        self,
        active_runtime_ids: set[str],
        *,
        stale_after_ms: int = STALE_TURN_MS,
    ) -> list[str]:
        """Interrupt orphaned in-flight turns.

        Both hosts (Hermes Desktop's embedded server and the web dashboard)
        share channels.db, so a booting backend must not blanket-interrupt turns
        another live host's worker is driving. A turn is only reaped when its
        runtime isn't in the caller's active set AND its journal has been
        silent for `stale_after_ms` (streaming/tool events count as liveness).
        Pass `stale_after_ms=0` for the single-host crash-restart semantics.
        """
        cutoff = _now_ms() - stale_after_ms
        interrupted: list[str] = []
        with self.repository.database.connect() as connection:
            rows = connection.execute(
                """SELECT turns.*, MAX(
                           COALESCE(
                               (SELECT MAX(created_at) FROM activity_events
                                 WHERE activity_events.turn_id = turns.id),
                               0
                           ),
                           turns.updated_at
                       ) AS last_activity_at
                   FROM turns
                   WHERE state IN ('claimed', 'running', 'waiting_approval')
                   ORDER BY created_at, id"""
            ).fetchall()
        for row in rows:
            runtime_id = row["runtime_session_id"]
            if runtime_id and runtime_id in active_runtime_ids:
                continue
            if row["last_activity_at"] > cutoff:
                continue
            turn = self._turn(row)
            # The agent may have durably persisted its final assistant message
            # just before the renderer/backend disappeared. Recover that fact
            # before classifying the orphan as interrupted; never rerun tools or
            # duplicate side effects merely because the completion event was lost.
            if self._recover_persisted_completion(turn):
                continue
            self._terminal_transition(turn, "interrupted", {})
            interrupted.append(row["id"])
        return interrupted

    def get(self, turn_id: str) -> TurnRecord:
        with self.repository.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM turns WHERE id = ?", (turn_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown turn: {turn_id}")
        return self._turn(row)

    def heartbeat(self, turn_id: str) -> bool:
        """Worker liveness signal for a turn it is actively driving.

        Reasoning models can stream nothing for minutes, so journal frames
        are not a liveness signal — the worker beats explicitly and the
        stale reap honors turns.updated_at.
        """
        now = _now_ms()
        with self.repository.database.connect() as connection:
            updated = connection.execute(
                """UPDATE turns SET updated_at = ?
                   WHERE id = ? AND state IN ('claimed', 'running', 'waiting_approval')""",
                (now, turn_id),
            )
        return updated.rowcount == 1

    def events_after(
        self,
        sequence: int,
        *,
        channel_id: str | None = None,
        limit: int | None = None,
    ) -> list[EventFrame]:
        query = "SELECT * FROM activity_events WHERE sequence > ?"
        params: list[Any] = [sequence]
        if channel_id is not None:
            query += " AND channel_id = ?"
            params.append(channel_id)
        if limit is not None:
            # Newest N, returned in ascending order like the unlimited path.
            query += " ORDER BY sequence DESC LIMIT ?"
            params.append(max(1, min(limit, 5000)))
            with self.repository.database.connect() as connection:
                rows = connection.execute(query, params).fetchall()
            return [self._frame(row) for row in reversed(rows)]
        query += " ORDER BY sequence"
        with self.repository.database.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._frame(row) for row in rows]

    def _archive_turn_session(self, turn: TurnRecord) -> None:
        """Every turn end-of-life hides its worker session (soft archive).
        Classification claims run under the default profile's store."""

        archive_stored_session(
            turn.profile_id or "default", turn.stored_session_id
        )

    def _terminal_transition(
        self,
        turn: TurnRecord,
        state: str,
        payload: dict[str, Any],
        *,
        error: str | None = None,
    ) -> TurnRecord:
        self._require_transition(turn.state, state)
        now = _now_ms()
        with self.repository.database.connect() as connection:
            connection.execute(
                """UPDATE turns SET state = ?, error = ?, completed_at = ?,
                       updated_at = ? WHERE id = ?""",
                (state, error, now, now, turn.id),
            )
            frame = self._insert_event(
                connection, turn.channel_id, turn.id, state, payload, now
            )
        self.event_bus.publish(frame)
        self._archive_turn_session(turn)
        return self.get(turn.id)

    @staticmethod
    def _require_transition(current: str, target: str) -> None:
        if target not in TRANSITIONS.get(current, set()):
            raise ValueError(f"invalid turn transition: {current} -> {target}")

    @staticmethod
    def _insert_event(
        connection: sqlite3.Connection,
        channel_id: str,
        turn_id: str | None,
        event_type: str,
        payload: dict[str, Any],
        created_at: int,
    ) -> EventFrame:
        cursor = connection.execute(
            """INSERT INTO activity_events
               (channel_id, turn_id, type, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (channel_id, turn_id, event_type, _canonical(payload), created_at),
        )
        return EventFrame(cursor.lastrowid, event_type, channel_id, turn_id, payload)

    @staticmethod
    def _turn(row: Any) -> TurnRecord:
        return TurnRecord(
            id=row["id"],
            channel_id=row["channel_id"],
            trigger_message_id=row["trigger_message_id"],
            root_message_id=row["root_message_id"],
            parent_turn_id=row["parent_turn_id"],
            profile_id=row["profile_id"],
            kind=row["kind"],
            trigger=row["trigger"],
            state=row["state"],
            depth=row["depth"],
            idempotency_key=row["idempotency_key"],
            context=row["context"],
            provider=row["provider"],
            model=row["model"],
            reasoning_effort=row["reasoning_effort"],
            cwd=row["cwd"],
            worker_id=row["worker_id"],
            runtime_session_id=row["runtime_session_id"],
            stored_session_id=row["stored_session_id"],
            result_message_id=row["result_message_id"],
            retry_of=row["retry_of"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _frame(row: Any) -> EventFrame:
        return EventFrame(
            sequence=row["sequence"],
            type=row["type"],
            channel_id=row["channel_id"],
            turn_id=row["turn_id"],
            payload=json.loads(row["payload_json"]),
        )

    @staticmethod
    def _claim_from_row(row: Any) -> DispatchClaim:
        if row["kind"] == "classification":
            payload = json.loads(row["context"])
            return DispatchClaim(
                id=row["id"],
                kind="classification",
                channel_id=row["channel_id"],
                instructions=payload["instructions"],
                input=payload["input"],
                provider=row["provider"],
                model=row["model"],
                reasoning_effort=row["reasoning_effort"],
                max_tokens=payload["maxTokens"],
                temperature=payload["temperature"],
                created_at=row["created_at"],
            )
        return DispatchClaim(
            id=row["id"],
            kind="agent",
            channel_id=row["channel_id"],
            profile_id=row["profile_id"],
            context=row["context"],
            cwd=row["cwd"],
            provider=row["provider"],
            model=row["model"],
            reasoning_effort=row["reasoning_effort"],
            created_at=row["created_at"],
        )
