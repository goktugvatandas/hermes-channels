"""Transactional persistence operations for Crew channels and messages."""

from dataclasses import dataclass
import json
import time
from typing import Any
from uuid import uuid4

from .db import CrewDatabase
from .models import ActivationPolicy, ProjectRef


def _now_ms() -> int:
    return int(time.time() * 1000)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _dump_project(project: ProjectRef | None) -> str | None:
    if project is None:
        return None
    return _canonical_json(project.model_dump(mode="json", by_alias=True))


def _load_project(raw: str | None) -> ProjectRef | None:
    return ProjectRef.model_validate_json(raw) if raw is not None else None


@dataclass(frozen=True, slots=True)
class ChannelRecord:
    id: str
    name: str
    purpose: str
    topic: str
    default_responder_profile: str | None
    default_project: ProjectRef | None
    allowed_projects: tuple[str, ...]
    routing_rules: dict[str, Any]
    created_at: int
    updated_at: int


@dataclass(frozen=True, slots=True)
class ChannelMemberRecord:
    channel_id: str
    profile_id: str
    activation_policy: ActivationPolicy
    created_at: int
    updated_at: int


@dataclass(frozen=True, slots=True)
class MessageRecord:
    id: str
    channel_id: str
    root_message_id: str | None
    parent_message_id: str | None
    author_type: str
    author_profile_id: str | None
    target_profile: str | None
    content: str
    idempotency_key: str | None
    mentions: tuple[str, ...]
    project: ProjectRef | None
    intent_envelope: dict[str, Any] | None
    model_label: str | None
    created_at: int


class CrewRepository:
    """Small command-oriented repository with one transaction per mutation."""

    def __init__(self, database: CrewDatabase):
        self.database = database

    def create_channel(
        self,
        name: str,
        *,
        purpose: str = "",
        topic: str = "",
        default_responder_profile: str | None = None,
        default_project: ProjectRef | None = None,
        allowed_projects: list[str] | None = None,
        routing_rules: dict[str, Any] | None = None,
    ) -> ChannelRecord:
        normalized_name = name.strip()
        if not normalized_name:
            raise ValueError("channel name is required")
        channel_id = uuid4().hex
        now = _now_ms()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO channels (
                       id, name, purpose, topic, default_responder_profile,
                       default_project_json, allowed_projects_json,
                       routing_rules_json, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    channel_id,
                    normalized_name,
                    purpose.strip(),
                    topic.strip(),
                    default_responder_profile,
                    _dump_project(default_project),
                    _canonical_json(allowed_projects or []),
                    _canonical_json(routing_rules or {}),
                    now,
                    now,
                ),
            )
        return self.require_channel(channel_id)

    def require_channel(self, channel_id: str) -> ChannelRecord:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM channels WHERE id = ?", (channel_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown channel: {channel_id}")
        return self._channel_from_row(row)

    def list_channels(self) -> list[ChannelRecord]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM channels ORDER BY created_at, id"
            ).fetchall()
        return [self._channel_from_row(row) for row in rows]

    def update_channel(
        self,
        channel_id: str,
        **changes: Any,
    ) -> ChannelRecord:
        allowed = {
            "name": "name",
            "purpose": "purpose",
            "topic": "topic",
            "default_responder_profile": "default_responder_profile",
            "default_project": "default_project_json",
            "allowed_projects": "allowed_projects_json",
            "routing_rules": "routing_rules_json",
        }
        unknown = set(changes) - set(allowed)
        if unknown:
            raise ValueError(f"unsupported channel fields: {sorted(unknown)}")
        self.require_channel(channel_id)
        if not changes:
            return self.require_channel(channel_id)
        assignments: list[str] = []
        values: list[Any] = []
        for field, value in changes.items():
            assignments.append(f"{allowed[field]} = ?")
            if field == "default_project":
                values.append(_dump_project(value))
            elif field in {"allowed_projects", "routing_rules"}:
                values.append(_canonical_json(value))
            elif isinstance(value, str):
                values.append(value.strip())
            else:
                values.append(value)
        assignments.append("updated_at = ?")
        values.extend((_now_ms(), channel_id))
        with self.database.connect() as connection:
            connection.execute(
                f"UPDATE channels SET {', '.join(assignments)} WHERE id = ?", values
            )
        return self.require_channel(channel_id)

    def add_member(
        self,
        channel_id: str,
        profile_id: str,
        *,
        activation_policy: ActivationPolicy = "mentioned",
        display_name: str | None = None,
        role: str = "",
        model_label: str | None = None,
        default_project: ProjectRef | None = None,
    ) -> ChannelMemberRecord:
        self.require_channel(channel_id)
        normalized_profile = profile_id.strip()
        if not normalized_profile:
            raise ValueError("profile_id is required")
        now = _now_ms()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO member_presentation (
                       profile_id, display_name, role, model_label,
                       default_project_json, archived, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 0, ?)
                   ON CONFLICT(profile_id) DO UPDATE SET
                       display_name = excluded.display_name,
                       role = excluded.role,
                       model_label = COALESCE(excluded.model_label, member_presentation.model_label),
                       default_project_json = COALESCE(
                           excluded.default_project_json,
                           member_presentation.default_project_json
                       ),
                       archived = 0,
                       updated_at = excluded.updated_at""",
                (
                    normalized_profile,
                    (display_name or normalized_profile).strip(),
                    role.strip(),
                    model_label,
                    _dump_project(default_project),
                    now,
                ),
            )
            connection.execute(
                """INSERT INTO channel_members (
                       channel_id, profile_id, activation_policy, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(channel_id, profile_id) DO UPDATE SET
                       activation_policy = excluded.activation_policy,
                       updated_at = excluded.updated_at""",
                (channel_id, normalized_profile, activation_policy, now, now),
            )
        return ChannelMemberRecord(
            channel_id=channel_id,
            profile_id=normalized_profile,
            activation_policy=activation_policy,
            created_at=now,
            updated_at=now,
        )

    def list_members(self, channel_id: str) -> list[ChannelMemberRecord]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT channel_id, profile_id, activation_policy, created_at, updated_at
                   FROM channel_members WHERE channel_id = ?
                   ORDER BY created_at, profile_id""",
                (channel_id,),
            ).fetchall()
        return [ChannelMemberRecord(**dict(row)) for row in rows]

    def member_default_project(self, profile_id: str) -> ProjectRef | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT default_project_json FROM member_presentation WHERE profile_id = ?",
                (profile_id,),
            ).fetchone()
        return _load_project(row[0]) if row is not None else None

    def append_message(
        self,
        channel_id: str,
        author_type: str,
        content: str,
        *,
        idempotency_key: str | None = None,
        mentions: list[str] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        root_message_id: str | None = None,
        parent_message_id: str | None = None,
        project: ProjectRef | None = None,
        author_profile_id: str | None = None,
        target_profile: str | None = None,
        intent_envelope: dict[str, Any] | None = None,
        author_snapshot: dict[str, Any] | None = None,
        model_label: str | None = None,
    ) -> MessageRecord:
        self.require_channel(channel_id)
        normalized_mentions = tuple(dict.fromkeys(mentions or []))
        now = _now_ms()
        message_id = uuid4().hex

        with self.database.connect() as connection:
            if idempotency_key is not None:
                existing = connection.execute(
                    "SELECT * FROM messages WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return self._message_from_row(existing)

            if root_message_id is not None:
                root = connection.execute(
                    "SELECT channel_id FROM messages WHERE id = ?",
                    (root_message_id,),
                ).fetchone()
                if root is None or root["channel_id"] != channel_id:
                    raise ValueError("thread root must belong to the target channel")

            connection.execute(
                """INSERT INTO messages (
                       id, channel_id, root_message_id, parent_message_id,
                       author_type, author_profile_id, target_profile_id,
                       content, idempotency_key, mentions_json, project_json,
                       intent_envelope_json, author_snapshot_json, model_label,
                       created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    message_id,
                    channel_id,
                    root_message_id,
                    parent_message_id,
                    author_type,
                    author_profile_id,
                    target_profile,
                    content,
                    idempotency_key,
                    _canonical_json(normalized_mentions),
                    _dump_project(project),
                    _canonical_json(intent_envelope)
                    if intent_envelope is not None
                    else None,
                    _canonical_json(author_snapshot or {}),
                    model_label,
                    now,
                ),
            )
            for attachment in attachments or []:
                connection.execute(
                    """INSERT INTO attachments (
                           id, message_id, kind, reference, label, metadata_json, created_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        uuid4().hex,
                        message_id,
                        str(attachment["kind"]),
                        str(attachment["reference"]),
                        attachment.get("label"),
                        _canonical_json(attachment.get("metadata", {})),
                        now,
                    ),
                )

            thread_root = root_message_id
            if thread_root is None and project is not None and project.mode != "inherit":
                thread_root = message_id
            if thread_root is not None:
                root_project = connection.execute(
                    "SELECT project_json FROM messages WHERE id = ?", (thread_root,)
                ).fetchone()
                connection.execute(
                    """INSERT OR IGNORE INTO threads (
                           root_message_id, channel_id, project_json, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?)""",
                    (
                        thread_root,
                        channel_id,
                        root_project["project_json"] if root_project else None,
                        now,
                        now,
                    ),
                )

            row = connection.execute(
                "SELECT * FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
        assert row is not None
        return self._message_from_row(row)

    def require_message(self, message_id: str) -> MessageRecord:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"unknown message: {message_id}")
        return self._message_from_row(row)

    def list_messages(self, channel_id: str) -> list[MessageRecord]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM messages
                   WHERE channel_id = ? AND root_message_id IS NULL
                   ORDER BY created_at, id""",
                (channel_id,),
            ).fetchall()
        return [self._message_from_row(row) for row in rows]

    def get_thread(self, root_message_id: str) -> list[MessageRecord]:
        root = self.require_message(root_message_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM messages
                   WHERE channel_id = ? AND (id = ? OR root_message_id = ?)
                   ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at, id""",
                (root.channel_id, root_message_id, root_message_id, root_message_id),
            ).fetchall()
        return [self._message_from_row(row) for row in rows]

    @staticmethod
    def _channel_from_row(row: Any) -> ChannelRecord:
        return ChannelRecord(
            id=row["id"],
            name=row["name"],
            purpose=row["purpose"],
            topic=row["topic"],
            default_responder_profile=row["default_responder_profile"],
            default_project=_load_project(row["default_project_json"]),
            allowed_projects=tuple(json.loads(row["allowed_projects_json"])),
            routing_rules=json.loads(row["routing_rules_json"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _message_from_row(row: Any) -> MessageRecord:
        return MessageRecord(
            id=row["id"],
            channel_id=row["channel_id"],
            root_message_id=row["root_message_id"],
            parent_message_id=row["parent_message_id"],
            author_type=row["author_type"],
            author_profile_id=row["author_profile_id"],
            target_profile=row["target_profile_id"],
            content=row["content"],
            idempotency_key=row["idempotency_key"],
            mentions=tuple(json.loads(row["mentions_json"])),
            project=_load_project(row["project_json"]),
            intent_envelope=json.loads(row["intent_envelope_json"])
            if row["intent_envelope_json"] is not None
            else None,
            model_label=row["model_label"],
            created_at=row["created_at"],
        )
