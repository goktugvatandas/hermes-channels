"""Deterministic Crew recipient selection and causal-loop enforcement."""

import re
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
# Intents that schedule the named recipients. `question` is included:
# the collaboration skill promises agents that asking someone by name
# gets them scheduled — omitting it made questions vanish silently.
REPLY_INTENTS = {"reply_required", "handoff", "review_request", "question"}
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
        *,
        extra_candidates: list[tuple[str, tuple[str, ...]]] | None = None,
    ) -> list[PlannedTurn]:
        message = self.repository.require_message(message_id)
        channel = self.repository.require_channel(message.channel_id)
        members = {
            member.profile_id: member
            for member in self.repository.list_members(message.channel_id)
        }
        rules = self._rules(channel.routing_rules, self._workspace_defaults())
        if message.author_type == "user":
            candidates = self._human_candidates(
                message, channel.default_responder_profile, members, classifier_suggestion
            )
            depth = 0
            prior: list[MessageRecord] = []
            tree_count = 0
        elif message.author_type == "agent":
            candidates = self._agent_candidates(message, members)
            prior = self._prior_agent_messages(message)
            depth = len(prior) + 1
            origin = self.repository.causal_origin(message.id)
            tree_count = self.repository.causal_tree_agent_count(origin)
        else:
            candidates = []
            depth = 0
            prior = []
            tree_count = 0

        if extra_candidates:
            # Steward judgments and similar injected wakes: still deduped and
            # still subject to every cap in the loop below.
            present = {profile_id for profile_id, _ in candidates}
            for profile_id, triggers in extra_candidates:
                member = members.get(profile_id)
                if member is None or member.activation_policy == "disabled":
                    continue
                if profile_id in present:
                    continue
                candidates.append((profile_id, triggers))
                present.add(profile_id)

        if not candidates:
            self._record(message, None, "no_reply", ())
            return []

        running = self._running_count(message.channel_id)
        available = max(0, rules["max_concurrency"] - running)
        planned: list[PlannedTurn] = []
        for profile_id, triggers in candidates:
            blocked = self._budget_block(
                message, profile_id, depth, rules, prior, tree_count + len(planned)
            )
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

    ROUTING_DEFAULTS_KEY = "routing_defaults"

    def _workspace_defaults(self) -> dict[str, Any]:
        try:
            return self.repository.get_setting(self.ROUTING_DEFAULTS_KEY) or {}
        except Exception:
            return {}

    @staticmethod
    def _rules(
        configured: dict[str, Any], workspace: dict[str, Any] | None = None
    ) -> dict[str, int]:
        """Built-in defaults < workspace defaults < per-channel overrides."""
        rules = dict(DEFAULT_RULES)
        for layer in (workspace or {}, configured):
            for key in rules:
                value = layer.get(key)
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

    def _agent_candidates(
        self, message: MessageRecord, members: dict[str, ChannelMemberRecord]
    ) -> list[tuple[str, tuple[str, ...]]]:
        try:
            envelope = IntentEnvelope.model_validate(message.intent_envelope or {})
        except ValidationError:
            return []
        result: list[tuple[str, tuple[str, ...]]] = []
        if (
            envelope.intent in REPLY_INTENTS
            and envelope.reply_expected
            and envelope.reply_budget > 0
        ):
            for profile_id in envelope.recipients:
                member = members.get(profile_id)
                if member is not None and member.activation_policy != "disabled":
                    result.append((profile_id, (f"intent:{envelope.intent}",)))
        # Collector pattern: a `result` that NAMES recipients is "delivering
        # back to you" — the delegator gets woken once to consolidate.
        # Recipient-less results (and prose thanks caught by the mention
        # fallback below, which excludes terminal intents) stay terminal.
        if envelope.intent == "result":
            for profile_id in envelope.recipients:
                member = members.get(profile_id)
                if member is not None and member.activation_policy != "disabled":
                    result.append((profile_id, ("intent:result",)))
        if result:
            return result
        # Mention fallback: models routinely write "@freya please analyze…"
        # in prose while leaving the envelope's recipients empty. Humans get
        # text-mention routing; agents do too — the same depth, budget, and
        # pair-repeat caps still gate every candidate, which is exactly what
        # those caps exist for. Terminal intents stay silent.
        if envelope.intent in {"result", "blocked", "approval_request"}:
            return []
        text = (message.content or "").lower()
        for profile_id, member in members.items():
            if member.activation_policy == "disabled":
                continue
            if profile_id == message.author_profile_id:
                continue
            handles = {profile_id.lower()}
            try:
                display = self.repository.get_member_presentation(profile_id).display_name
                handle = re.sub(r"[^\w-]", "", display or "")
                if handle:
                    handles.add(handle.lower())
            except Exception:
                pass
            if any(
                re.search(rf"(^|[\s([{{])@{re.escape(handle)}(?![\w-])", text)
                for handle in handles
            ):
                result.append((profile_id, ("agent_mention",)))
        return result

    def _budget_block(
        self,
        message: MessageRecord,
        target_profile: str,
        depth: int,
        rules: dict[str, int],
        prior: list[MessageRecord],
        tree_count: int,
    ) -> str | None:
        if message.author_type == "agent":
            if depth > rules["max_depth"]:
                return "loop_blocked"
            source = message.author_profile_id
            if source and self._pair_count(prior, source, target_profile) >= rules[
                "max_pair_repeats"
            ]:
                return "loop_blocked"
            # The automated-turn budget bounds the whole causal tree from the
            # originating human message — fan-outs (one message naming several
            # recipients) share one budget instead of getting one per branch.
            if tree_count >= rules["max_automated_turns"]:
                return "budget_blocked"
        return None

    def _prior_agent_messages(self, message: MessageRecord) -> list[MessageRecord]:
        """Prior agent messages along the causal turn chain behind this message.

        Walks turns' trigger->result lineage instead of thread containment, so
        automation budgets bound uninterrupted agent-to-agent relays wherever
        the messages land (channel level or threads). A human-authored trigger
        ends the walk: human input resets the automated-chain budget.
        """
        chain: list[MessageRecord] = []
        visited = {message.id}
        current_id = message.id
        with self.repository.database.connect() as connection:
            while True:
                turn_row = connection.execute(
                    "SELECT trigger_message_id FROM turns WHERE result_message_id = ?",
                    (current_id,),
                ).fetchone()
                if turn_row is None or turn_row["trigger_message_id"] in visited:
                    break
                trigger_row = connection.execute(
                    "SELECT * FROM messages WHERE id = ?",
                    (turn_row["trigger_message_id"],),
                ).fetchone()
                if trigger_row is None:
                    break
                trigger = self.repository._message_from_row(trigger_row)
                if trigger.author_type != "agent":
                    break
                chain.append(trigger)
                visited.add(trigger.id)
                current_id = trigger.id
        chain.reverse()
        return chain

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
