"""The Steward: a hidden, off-by-default automation agent for stuck lifecycles.

Agent chains stall for mundane reasons: a model forgets its envelope, a
recipient was concurrency-blocked at the moment of routing, or a worker died
mid-turn. The Steward sweeps on a schedule and unblocks those paths with the
same primitives a human would use — re-planning a message's recipients and
retrying orphaned turns. It is rule-based (no model calls, effectively free)
and every action it takes still passes the normal routing budgets.
"""

from __future__ import annotations

import json
import time
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from .models import IntentEnvelope
from .repositories import CrewRepository, MessageRecord
from .routing import REPLY_INTENTS, Router
from .scheduler import Scheduler

SETTINGS_KEY = "steward"

DEFAULT_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "intervalMinutes": 5,
    "stallMinutes": 5,
    # Optional judgment model: with these set, ambiguous stalls (nothing
    # named, nothing in flight, conversation looks unfinished) get one cheap
    # model call deciding whom to wake. Null = rules only.
    "provider": None,
    "model": None,
}

# Only look back this far: ancient conversations should stay asleep.
_LOOKBACK_MS = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def load_settings(repository: CrewRepository) -> dict[str, Any]:
    stored = repository.get_setting(SETTINGS_KEY) or {}
    merged = {**DEFAULT_SETTINGS, **{k: stored[k] for k in DEFAULT_SETTINGS if k in stored}}
    return merged


def save_settings(repository: CrewRepository, changes: dict[str, Any]) -> dict[str, Any]:
    stored = repository.get_setting(SETTINGS_KEY) or {}
    stored.update(changes)
    repository.set_setting(SETTINGS_KEY, stored)
    return load_settings(repository)


def _expected_recipients(message: MessageRecord) -> list[str]:
    """Recipients this message should have scheduled, per its envelope."""

    try:
        envelope = IntentEnvelope.model_validate(message.intent_envelope or {})
    except ValidationError:
        return []
    if envelope.intent in REPLY_INTENTS and envelope.reply_expected and envelope.reply_budget > 0:
        return list(envelope.recipients)
    if envelope.intent == "result" and envelope.recipients:
        return list(envelope.recipients)
    return []


class Steward:
    def __init__(self, repository: CrewRepository, scheduler: Scheduler, router: Router):
        self.repository = repository
        self.scheduler = scheduler
        self.router = router

    def maybe_sweep(self) -> None:
        """Throttled entry point piggybacked on worker claim polls."""

        settings = load_settings(self.repository)
        if not settings["enabled"]:
            return
        stored = self.repository.get_setting(SETTINGS_KEY) or {}
        last_run = int(stored.get("lastRunAt") or 0)
        interval_ms = int(settings["intervalMinutes"]) * 60 * 1000
        now = _now_ms()
        if now - last_run < interval_ms:
            return
        stored["lastRunAt"] = now
        self.repository.set_setting(SETTINGS_KEY, stored)
        self.sweep(
            stall_ms=int(settings["stallMinutes"]) * 60 * 1000,
            provider=settings.get("provider"),
            model=settings.get("model"),
        )

    def sweep(
        self,
        *,
        stall_ms: int,
        provider: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """One pass: deterministic unblocks, plus (with a model configured)
        one judgment turn per ambiguously-stalled channel."""

        now = _now_ms()
        replanned: list[str] = []
        retried: list[str] = []
        judged: list[str] = []
        blocked: list[str] = []

        with self.repository.database.connect() as connection:
            stalled_messages = connection.execute(
                """SELECT id FROM messages
                   WHERE author_type = 'agent'
                     AND created_at < ? AND created_at > ?
                   ORDER BY created_at DESC LIMIT 200""",
                (now - stall_ms, now - _LOOKBACK_MS),
            ).fetchall()
            orphaned = connection.execute(
                """SELECT id FROM turns
                   WHERE state = 'interrupted'
                     AND updated_at < ? AND updated_at > ?
                     AND trigger != 'retry'
                     AND NOT EXISTS (
                         SELECT 1 FROM turns retryer WHERE retryer.retry_of = turns.id
                     )
                   ORDER BY updated_at DESC LIMIT 20""",
                (now - stall_ms, now - _LOOKBACK_MS),
            ).fetchall()

        for row in stalled_messages:
            message = self.repository.require_message(row["id"])
            expected = _expected_recipients(message)
            if not expected:
                continue
            with self.repository.database.connect() as connection:
                served = {
                    turn_row["profile_id"]
                    for turn_row in connection.execute(
                        "SELECT profile_id FROM turns WHERE trigger_message_id = ?",
                        (message.id,),
                    ).fetchall()
                }
            if set(expected) <= served:
                continue
            # Re-planning is idempotent: enqueue dedupes on
            # agent:<message>:<profile>, and every routing cap re-applies.
            planned_profiles: set[str] = set()
            for planned in self.router.plan(message.id):
                self.scheduler.enqueue(planned)
                planned_profiles.add(planned.profile_id)
                replanned.append(f"{message.id[:8]}->{planned.profile_id}")
            # Anything still unserved was refused by routing (loop budget,
            # depth, pair repeats). Saying "found nothing" here hid real
            # stalls; report them so the human knows a message of theirs
            # resets the automation budget.
            for profile_id in expected:
                if profile_id not in served and profile_id not in planned_profiles:
                    blocked.append(f"{message.id[:8]}->{profile_id}")

        for row in orphaned:
            try:
                self.scheduler.retry(row["id"])
                retried.append(row["id"][:8])
            except (KeyError, ValueError):
                continue

        if provider and model:
            judged = self._judge_ambiguous_stalls(
                stall_ms=stall_ms, provider=provider, model=model, now=now
            )

        return {
            "replanned": replanned,
            "retried": retried,
            "judged": judged,
            "blocked": blocked,
        }

    def _judge_ambiguous_stalls(
        self, *, stall_ms: int, provider: str, model: str, now: int
    ) -> list[str]:
        """Enqueue one model judgment per channel whose conversation looks
        unfinished but names nobody the rules could wake. One judgment per
        message, ever (idempotency steward:<message>)."""

        judged: list[str] = []
        with self.repository.database.connect() as connection:
            latest = connection.execute(
                """SELECT m.id FROM messages m
                   WHERE m.author_type = 'agent'
                     AND m.created_at < ? AND m.created_at > ?
                     AND m.created_at = (
                         SELECT MAX(created_at) FROM messages
                         WHERE channel_id = m.channel_id
                     )
                     AND NOT EXISTS (
                         SELECT 1 FROM turns
                         WHERE turns.channel_id = m.channel_id
                           AND turns.state IN ('queued', 'claimed', 'running', 'waiting_approval')
                     )""",
                (now - stall_ms, now - _LOOKBACK_MS),
            ).fetchall()
        for row in latest:
            message = self.repository.require_message(row["id"])
            if _expected_recipients(message):
                continue  # the deterministic pass owns named recipients
            members = [
                member.profile_id
                for member in self.repository.list_members(message.channel_id)
                if member.activation_policy != "disabled"
                and member.profile_id != message.author_profile_id
            ]
            if not members:
                continue
            with self.repository.database.connect() as connection:
                recent = connection.execute(
                    """SELECT author_type, author_profile_id, content FROM messages
                       WHERE channel_id = ? ORDER BY created_at DESC LIMIT 6""",
                    (message.channel_id,),
                ).fetchall()
            transcript = "\n".join(
                f"{r['author_profile_id'] or r['author_type']}: {r['content'][:300]}"
                for r in reversed(recent)
            )
            payload = json.dumps(
                {
                    "instructions": (
                        "You are the Steward of a multi-agent channel. The "
                        "conversation below has stalled: the last message is "
                        "from an agent and no work is in flight. Decide whether "
                        "another member must be woken to keep the work moving "
                        "(e.g. a promised delegation never happened, or an "
                        "unanswered request). Reply with ONLY this JSON: "
                        '{"respond": true|false, "wake": ["<member id>"], '
                        '"confidence": 0.0-1.0}. Wake at most the members '
                        "strictly needed; respond false if the conversation is "
                        "genuinely finished. Member ids you may wake: "
                        + ", ".join(members)
                    ),
                    "input": transcript,
                    "maxTokens": 200,
                    "temperature": 0,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            claim_id = uuid4().hex
            with self.repository.database.connect() as connection:
                inserted = connection.execute(
                    """INSERT OR IGNORE INTO turns (
                           id, channel_id, trigger_message_id, root_message_id,
                           profile_id, kind, trigger, state, depth,
                           idempotency_key, context, rule_snapshot_json,
                           provider, model, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, NULL, 'classification', 'steward',
                           'queued', 0, ?, ?, '{}', ?, ?, ?, ?)""",
                    (
                        claim_id,
                        message.channel_id,
                        message.id,
                        message.root_message_id,
                        f"steward:{message.id}",
                        payload,
                        provider,
                        model,
                        now,
                        now,
                    ),
                )
                if inserted.rowcount == 1:
                    connection.execute(
                        """INSERT INTO activity_events
                           (channel_id, turn_id, type, payload_json, created_at)
                           VALUES (?, ?, 'queued', '{"kind":"steward"}', ?)""",
                        (message.channel_id, claim_id, now),
                    )
                    judged.append(message.id[:8])
        return judged
