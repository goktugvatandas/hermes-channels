"""Stable human-facing card references over Hermes' opaque task ids."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
from types import SimpleNamespace
from typing import Any, Iterable

from .db import CrewDatabase

BOARD_PREFIXES = {
    "channel-seatech": "SD",
    "channel-the-others": "TO",
    "channel-circle": "CR",
    "channel-kronomyth": "KM",
    "channel-oss": "OS",
    "channel-hq": "HQ",
    "channel-cultdrops": "CD",
}

_REFERENCE = re.compile(r"^[A-Z][A-Z0-9]{0,7}-[1-9][0-9]*$")


def prefix_for_board(board_slug: str) -> str:
    known = BOARD_PREFIXES.get(board_slug)
    if known:
        return known
    if board_slug.startswith("channel-cultdrops-"):
        return "CD"
    name = board_slug.removeprefix("channel-")
    words = [word for word in re.split(r"[^a-zA-Z0-9]+", name) if word]
    if len(words) > 1:
        return "".join(word[0] for word in words[:3]).upper()
    compact = re.sub(r"[^a-zA-Z0-9]", "", name).upper()
    return (compact[:2] or "KB")


class CardReferenceStore:
    """Allocate and resolve immutable per-board human card references."""

    def __init__(self, database: CrewDatabase):
        self.database = database

    def ensure_references(
        self,
        board_slug: str,
        tasks: Iterable[Any],
    ) -> dict[str, str]:
        ordered = sorted(tasks, key=lambda task: (int(task.created_at), str(task.id)))
        task_ids = [str(task.id) for task in ordered]
        if not task_ids:
            return {}
        prefix = prefix_for_board(board_slug)
        now = int(time.time() * 1000)
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing_rows = connection.execute(
                """SELECT task_id, reference FROM kanban_card_references
                   WHERE board_slug = ?""",
                (board_slug,),
            ).fetchall()
            existing = {str(row["task_id"]): str(row["reference"]) for row in existing_rows}
            counter = connection.execute(
                "SELECT next_sequence FROM kanban_reference_counters WHERE prefix = ?",
                (prefix,),
            ).fetchone()
            if counter is None:
                maximum = connection.execute(
                    "SELECT COALESCE(MAX(sequence), 0) FROM kanban_card_references WHERE prefix = ?",
                    (prefix,),
                ).fetchone()[0]
                next_sequence = int(maximum) + 1
            else:
                next_sequence = int(counter["next_sequence"])
            for task in ordered:
                task_id = str(task.id)
                if task_id in existing:
                    continue
                reference = f"{prefix}-{next_sequence}"
                connection.execute(
                    """INSERT INTO kanban_card_references
                       (board_slug, task_id, prefix, sequence, reference, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (board_slug, task_id, prefix, next_sequence, reference, now),
                )
                existing[task_id] = reference
                next_sequence += 1
            connection.execute(
                """INSERT INTO kanban_reference_counters
                   (prefix, next_sequence) VALUES (?, ?)
                   ON CONFLICT(prefix) DO UPDATE SET
                       next_sequence = excluded.next_sequence""",
                (prefix, next_sequence),
            )
        return {task_id: existing[task_id] for task_id in task_ids}

    def reference_for(self, board_slug: str, task_id: str) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT reference FROM kanban_card_references
                   WHERE board_slug = ? AND task_id = ?""",
                (board_slug, task_id),
            ).fetchone()
        return str(row["reference"]) if row is not None else None

    def resolve(self, board_slug: str, value: str) -> str | None:
        candidate = value.strip()
        if candidate.startswith("t_"):
            return candidate
        normalized = candidate.upper()
        if not _REFERENCE.fullmatch(normalized):
            return None
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT task_id FROM kanban_card_references
                   WHERE board_slug = ? AND reference = ?""",
                (board_slug, normalized),
            ).fetchone()
        return str(row["task_id"]) if row is not None else None


def _shared_database_path() -> Path:
    try:
        from hermes_constants import get_process_hermes_home

        home = Path(get_process_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return home / "channels" / "channels.db"


def _task_records(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        task_id = value.get("id")
        if isinstance(task_id, str) and task_id.startswith("t_"):
            found.append(value)
        for child in value.values():
            found.extend(_task_records(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_task_records(child))
    return found


def annotate_kanban_tool_result(
    *,
    tool_name: str,
    args: dict[str, Any],
    result: str,
    database_path: str | Path | None = None,
    **_: Any,
) -> str | None:
    """Add stable human references to kanban tool JSON seen by agents."""

    if not tool_name.startswith("kanban_") or not isinstance(result, str):
        return None
    board = str(args.get("board") or os.environ.get("HERMES_KANBAN_BOARD") or "").strip()
    if not board:
        return None
    try:
        payload = json.loads(result)
    except (TypeError, json.JSONDecodeError):
        return None
    records = _task_records(payload)
    if not records:
        return None
    tasks = [
        SimpleNamespace(
            id=record["id"],
            created_at=int(record.get("created_at") or record.get("createdAt") or 0),
        )
        for record in records
    ]
    store = CardReferenceStore(
        CrewDatabase(Path(database_path) if database_path is not None else _shared_database_path())
    )
    references = store.ensure_references(board, tasks)
    for record in records:
        record["reference"] = references[record["id"]]
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def translate_kanban_tool_args(
    *,
    tool_name: str,
    args: dict[str, Any],
    database_path: str | Path | None = None,
    **_: Any,
) -> dict[str, Any] | None:
    """Translate human references in kanban tool input to host task ids."""

    if not tool_name.startswith("kanban_") or not isinstance(args, dict):
        return None
    board = str(args.get("board") or os.environ.get("HERMES_KANBAN_BOARD") or "").strip()
    if not board:
        return None
    store = CardReferenceStore(
        CrewDatabase(Path(database_path) if database_path is not None else _shared_database_path())
    )
    modified: dict[str, str] = {}
    for key in ("task_id", "parent_id", "child_id"):
        value = args.get(key)
        if not isinstance(value, str) or value.startswith("t_"):
            continue
        resolved = store.resolve(board, value)
        if resolved:
            modified[key] = resolved
    return {"action": "modify", "args": modified} if modified else None
