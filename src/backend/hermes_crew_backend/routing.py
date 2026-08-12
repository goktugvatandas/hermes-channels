"""Deterministic Crew recipient selection and causal-loop enforcement."""

from dataclasses import dataclass
import json
import time
from typing import Any

from pydantic import ValidationError

from .classifier import ClassificationSuggestion
from .models import IntentEnvelope
from .repositories import ChannelMemberRecord, CrewRepository, MessageRecord


DEFAULT_RULES: dict[str, int] = {
    "max_depth": 2,
    "max_automated_turns": 6,
    "max_pair_repeats": 1,
    "max_concurrency": 4,
}
REPLY_INTENTS = {"reply_required", "handoff", "review_request"}
RUNNING_STATES = {"claimed", "running", "waiting_approval"}


@dataclass(frozen=True, slots=True)
class PlannedTurn:
    channel_id: str
    message_id: str
    profile_id: str
    trigger: str
    triggers: tuple[str, ...]
    depth: int
    rule_snapshot: dict[str, int]


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    message_id: str
    profile_id: str | None
    disposition: str
    reasons: tuple[str, ...]
    created_at: int


class Router:
    def __init__(self, repository: CrewRepository):
        self.repository = repository

    def plan(
        self,
        message_id: str,
        classifier_suggestion: ClassificationSuggestion | None = None,
    ) -> list[PlannedTurn]:
        message = self.repository.require_message(message_id)
        channel = self.repository.require_channel(message.channel_id)
        members = {
            member.profile_id: member
            for member in self.repository.list_members(message.channel_id)
        }
        rules = self._rules(channel.routing_rules)
        if message.author_type == "user":
            candidates = self._human_candidates(
                message, channel.default_responder_profile, members, classifier_suggestion
            )
            depth = 0
        elif message.author_type == "agent":
            candidates = self._agent_candidates(message, members)
            depth = self._next_depth(message)
        else:
            candidates = []
            depth = 0

        if not candidates:
            self._record(message, None, "no_reply", ())
            return []

        running = self._running_count(message.channel_id)
        available = max(0, rules["max_concurrency"] - running)
        planned: list[PlannedTurn] = []
        for profile_id, triggers in candidates:
            blocked = self._budget_block(message, profile_id, depth, rules)
            if blocked is not None:
                self._record(message, profile_id, blocked, triggers)
                continue
            if available <= 0:
                self._record(message, profile_id, "concurrency_blocked", triggers)
                continue
            planned.append(
                PlannedTurn(
                    channel_id=message.channel_id,
                    message_id=message.id,
                    profile_id=profile_id,
                    trigger=triggers[0],
                    triggers=triggers,
                    depth=depth,
                    rule_snapshot=dict(rules),
                )
            )
            available -= 1
            self._record(message, profile_id, "scheduled", triggers)
        return planned

    def decisions_for(self, message_id: str) -> list[RoutingDecision]:
        with self.repository.database.connect() as connection:
            rows = connection.execute(
                """SELECT payload_json, created_at FROM activity_events
                   WHERE type = 'routing_decision'
                   ORDER BY sequence"""
            ).fetchall()
        decisions: list[RoutingDecision] = []
        for row in rows:
            payload = json.loads(row["payload_json"])
            if payload.get("messageId") != message_id:
                continue
            decisions.append(
                RoutingDecision(
                    message_id=message_id,
                    profile_id=payload.get("profileId"),
                    disposition=payload["disposition"],
                    reasons=tuple(payload.get("reasons", [])),
                    created_at=row["created_at"],
                )
            )
        return decisions

    @staticmethod
    def _rules(configured: dict[str, Any]) -> dict[str, int]:
        rules = dict(DEFAULT_RULES)
        for key in rules:
            value = configured.get(key)
            if isinstance(value, int) and value >= 0:
                rules[key] = value
        return rules

    @staticmethod
    def _add_candidate(
        ordered: dict[str, list[str]], profile_id: str, trigger: str
    ) -> None:
        ordered.setdefault(profile_id, []).append(trigger)

    def _human_candidates(
        self,
        message: MessageRecord,
        default_profile: str | None,
        members: dict[str, ChannelMemberRecord],
        classifier_suggestion: ClassificationSuggestion | None,
    ) -> list[tuple[str, tuple[str, ...]]]:
        ordered: dict[str, list[str]] = {}
        for mentioned in message.mentions:
            if mentioned == "all":
                for member in members.values():
                    if member.activation_policy != "disabled":
                        self._add_candidate(ordered, member.profile_id, "mention:@all")
                continue
            member = members.get(mentioned)
            if member is not None and member.activation_policy != "disabled":
                self._add_candidate(ordered, mentioned, "mention")

        default_member = members.get(default_profile) if default_profile else None
        if default_member is not None and default_member.activation_policy not in {
            "observer",
            "disabled",
        }:
            self._add_candidate(ordered, default_member.profile_id, "default")
        for member in members.values():
            if member.activation_policy == "always":
                self._add_candidate(ordered, member.profile_id, "always")
        if classifier_suggestion is not None:
            for profile_id in classifier_suggestion.recipients:
                member = members.get(profile_id)
                if member is not None and member.activation_policy != "disabled":
                    self._add_candidate(ordered, profile_id, "classifier")
        return [(profile_id, tuple(triggers)) for profile_id, triggers in ordered.items()]

    @staticmethod
    def _agent_candidates(
        message: MessageRecord, members: dict[str, ChannelMemberRecord]
    ) -> list[tuple[str, tuple[str, ...]]]:
        try:
            envelope = IntentEnvelope.model_validate(message.intent_envelope or {})
        except ValidationError:
            return []
        if (
            envelope.intent not in REPLY_INTENTS
            or not envelope.reply_expected
            or envelope.reply_budget <= 0
        ):
            return []
        result: list[tuple[str, tuple[str, ...]]] = []
        for profile_id in envelope.recipients:
            member = members.get(profile_id)
            if member is not None and member.activation_policy != "disabled":
                result.append((profile_id, (f"intent:{envelope.intent}",)))
        return result

    def _next_depth(self, message: MessageRecord) -> int:
        return len(self._prior_agent_messages(message)) + 1

    def _budget_block(
        self,
        message: MessageRecord,
        target_profile: str,
        depth: int,
        rules: dict[str, int],
    ) -> str | None:
        prior = self._prior_agent_messages(message)
        if message.author_type == "agent":
            if depth > rules["max_depth"]:
                return "loop_blocked"
            source = message.author_profile_id
            if source and self._pair_count(prior, source, target_profile) >= rules[
                "max_pair_repeats"
            ]:
                return "loop_blocked"
            if len(prior) + 1 >= rules["max_automated_turns"]:
                return "budget_blocked"
        return None

    def _prior_agent_messages(self, message: MessageRecord) -> list[MessageRecord]:
        if not message.root_message_id:
            return []
        with self.repository.database.connect() as connection:
            current = connection.execute(
                "SELECT rowid FROM messages WHERE id = ?", (message.id,)
            ).fetchone()
            assert current is not None
            rows = connection.execute(
                """SELECT * FROM messages
                   WHERE root_message_id = ? AND author_type = 'agent' AND rowid < ?
                   ORDER BY rowid""",
                (message.root_message_id, current["rowid"]),
            ).fetchall()
        return [self.repository._message_from_row(row) for row in rows]

    @staticmethod
    def _pair_count(
        messages: list[MessageRecord], source_profile: str, target_profile: str
    ) -> int:
        count = 0
        for historical in messages:
            if historical.author_profile_id != source_profile:
                continue
            try:
                envelope = IntentEnvelope.model_validate(
                    historical.intent_envelope or {}
                )
            except ValidationError:
                continue
            if (
                envelope.intent in REPLY_INTENTS
                and envelope.reply_expected
                and target_profile in envelope.recipients
            ):
                count += 1
        return count

    def _running_count(self, channel_id: str) -> int:
        placeholders = ",".join("?" for _ in RUNNING_STATES)
        with self.repository.database.connect() as connection:
            row = connection.execute(
                f"SELECT COUNT(*) FROM turns WHERE channel_id = ? AND state IN ({placeholders})",
                (channel_id, *sorted(RUNNING_STATES)),
            ).fetchone()
        assert row is not None
        return int(row[0])

    def _record(
        self,
        message: MessageRecord,
        profile_id: str | None,
        disposition: str,
        reasons: tuple[str, ...],
    ) -> None:
        now = int(time.time() * 1000)
        payload = json.dumps(
            {
                "disposition": disposition,
                "messageId": message.id,
                "profileId": profile_id,
                "reasons": list(reasons),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        with self.repository.database.connect() as connection:
            connection.execute(
                """INSERT INTO activity_events
                   (channel_id, turn_id, type, payload_json, created_at)
                   VALUES (?, NULL, 'routing_decision', ?, ?)""",
                (message.channel_id, payload, now),
            )
