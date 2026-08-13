"""Optional, disabled-by-default classifier planning and validation."""

from dataclasses import dataclass
import json
import time
from typing import Any
from uuid import uuid4

from .context_builder import ContextBuilder
from .models import MessageIntent
from .repositories import CrewRepository


_INTENTS = {
    "inform",
    "result",
    "reply_required",
    "question",
    "handoff",
    "review_request",
    "blocked",
    "approval_request",
}


@dataclass(frozen=True, slots=True)
class ClassificationClaim:
    id: str
    kind: str
    channel_id: str
    message_id: str
    provider: str
    model: str
    reasoning_effort: str | None
    max_tokens: int
    temperature: float
    instructions: str
    input: str
    created_at: int


@dataclass(frozen=True, slots=True)
class ClassificationSuggestion:
    intent: MessageIntent
    recipients: tuple[str, ...]
    confidence: float


class Classifier:
    def __init__(self, repository: CrewRepository):
        self.repository = repository

    def configure(
        self,
        channel_id: str,
        *,
        enabled: bool,
        provider: str | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int = 300,
        confidence_threshold: float = 0.65,
    ) -> None:
        self.repository.require_channel(channel_id)
        now = int(time.time() * 1000)
        with self.repository.database.connect() as connection:
            connection.execute(
                """INSERT INTO classifier_configs (
                       channel_id, enabled, provider, model, reasoning_effort,
                       max_tokens, confidence_threshold, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(channel_id) DO UPDATE SET
                       enabled = excluded.enabled,
                       provider = excluded.provider,
                       model = excluded.model,
                       reasoning_effort = excluded.reasoning_effort,
                       max_tokens = excluded.max_tokens,
                       confidence_threshold = excluded.confidence_threshold,
                       updated_at = excluded.updated_at""",
                (
                    channel_id,
                    int(enabled),
                    provider,
                    model,
                    reasoning_effort,
                    max_tokens,
                    confidence_threshold,
                    now,
                ),
            )

    def plan(self, message_id: str) -> ClassificationClaim | None:
        message = self.repository.require_message(message_id)
        with self.repository.database.connect() as connection:
            config = connection.execute(
                "SELECT * FROM classifier_configs WHERE channel_id = ?",
                (message.channel_id,),
            ).fetchone()
        if config is None or not config["enabled"]:
            return None
        if not config["provider"] or not config["model"]:
            return None
        instructions, classifier_input = ContextBuilder(
            self.repository
        ).for_classifier(message)
        claim_id = uuid4().hex
        created_at = int(time.time() * 1000)
        idempotency_key = f"classifier:{message.id}"
        claim_payload = json.dumps(
            {
                "input": classifier_input,
                "instructions": instructions,
                "maxTokens": config["max_tokens"],
                "temperature": 0,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        config_snapshot = json.dumps(
            {
                "confidenceThreshold": config["confidence_threshold"],
                "maxTokens": config["max_tokens"],
                "model": config["model"],
                "provider": config["provider"],
                "reasoningEffort": config["reasoning_effort"],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        with self.repository.database.connect() as connection:
            inserted = connection.execute(
                """INSERT OR IGNORE INTO turns (
                       id, channel_id, trigger_message_id, root_message_id,
                       profile_id, kind, trigger, state, depth, idempotency_key,
                       context, rule_snapshot_json, provider, model,
                       reasoning_effort, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, NULL, 'classification', 'classifier',
                       'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    claim_id,
                    message.channel_id,
                    message.id,
                    message.root_message_id,
                    idempotency_key,
                    claim_payload,
                    config_snapshot,
                    config["provider"],
                    config["model"],
                    config["reasoning_effort"],
                    created_at,
                    created_at,
                ),
            )
            if inserted.rowcount == 1:
                connection.execute(
                    """INSERT INTO activity_events
                       (channel_id, turn_id, type, payload_json, created_at)
                       VALUES (?, ?, 'queued', ?, ?)""",
                    (
                        message.channel_id,
                        claim_id,
                        json.dumps(
                            {"kind": "classification"},
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                        created_at,
                    ),
                )
            turn = connection.execute(
                "SELECT * FROM turns WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        assert turn is not None
        payload = json.loads(turn["context"])
        return ClassificationClaim(
            id=turn["id"],
            kind="classification",
            channel_id=turn["channel_id"],
            message_id=turn["trigger_message_id"],
            provider=turn["provider"],
            model=turn["model"],
            reasoning_effort=turn["reasoning_effort"],
            max_tokens=payload["maxTokens"],
            temperature=payload["temperature"],
            instructions=payload["instructions"],
            input=payload["input"],
            created_at=turn["created_at"],
        )

    def parse_result(
        self, raw: str, channel_id: str
    ) -> ClassificationSuggestion | None:
        try:
            payload: Any = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(payload, dict) or set(payload) != {
            "intent",
            "recipients",
            "confidence",
        }:
            return None
        intent = payload["intent"]
        recipients = payload["recipients"]
        confidence = payload["confidence"]
        if intent not in _INTENTS:
            return None
        if (
            not isinstance(recipients, list)
            or any(not isinstance(value, str) or not value for value in recipients)
            or len(set(recipients)) != len(recipients)
            or not isinstance(confidence, (int, float))
        ):
            return None
        with self.repository.database.connect() as connection:
            config = connection.execute(
                "SELECT confidence_threshold FROM classifier_configs WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
        threshold = config["confidence_threshold"] if config else 0.65
        if not 0 <= confidence <= 1 or confidence < threshold:
            return None
        enabled = {
            member.profile_id
            for member in self.repository.list_members(channel_id)
            if member.activation_policy != "disabled"
        }
        if not set(recipients) <= enabled:
            return None
        return ClassificationSuggestion(intent, tuple(recipients), float(confidence))
