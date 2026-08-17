"""Keep channel worker sessions out of the host's session surfaces.

Channel turns run as real Hermes sessions under each agent's profile. Created
with ``source: 'tool'`` they already stay out of the session sidebar, the
gateway's ``session.list``, and Bot Mode's per-bot previews (all three honour
the same source deny-list) — archiving the stored row once the turn finishes
additionally hides it from the command palette, artifacts, and project trees.
Archived is a soft hide: the "Open session" buttons resolve sessions by id,
which ignores both flags.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

_log = logging.getLogger(__name__)


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _state_db(profile_id: str) -> Path | None:
    home = _hermes_home()
    per_profile = home / "profiles" / profile_id / "state.db"
    if per_profile.exists():
        return per_profile
    # The default profile keeps its sessions in the shared home store.
    if profile_id == "default":
        main = home / "state.db"
        if main.exists():
            return main
    return None


def read_completed_response_from_db(
    db_path: Path,
    stored_session_id: str,
    *,
    not_before_ms: int | None = None,
) -> str:
    """Assemble the completed current-turn response from one profile transcript."""

    try:
        import sqlite3

        with sqlite3.connect(db_path) as connection:
            query = """SELECT role, content, finish_reason FROM messages
                       WHERE session_id = ?"""
            params: list[object] = [stored_session_id]
            if not_before_ms is not None:
                query += " AND timestamp >= ?"
                params.append(not_before_ms / 1000)
            query += " ORDER BY id"
            rows = connection.execute(query, params).fetchall()
    except Exception:
        _log.debug(
            "channel response transcript read skipped for %s",
            stored_session_id,
            exc_info=True,
        )
        return ""
    if not rows:
        return ""
    last_user = max(
        (index for index, row in enumerate(rows) if row[0] == "user"),
        default=-1,
    )
    current_turn = rows[last_user + 1 :]
    if not current_turn:
        return ""
    final = current_turn[-1]
    if final[0] != "assistant" or final[2] != "stop" or not final[1]:
        return ""
    parts = [
        str(row[1]).strip()
        for row in current_turn
        if row[0] == "assistant" and row[1] and str(row[1]).strip()
    ]
    return "\n\n".join(parts)


def read_completed_response(
    profile_id: str | None,
    stored_session_id: str | None,
    *,
    not_before_ms: int | None = None,
) -> str:
    """Return a persisted final assistant response, never an interim/tool step.

    ``finish_reason='stop'`` is the durable proof that the model completed its
    final answer before a renderer or process disappeared. Missing/older schema
    variants fail closed to an empty response so unfinished work is never
    replayed as if it succeeded.
    """

    if not profile_id or not stored_session_id:
        return ""
    db_path = _state_db(profile_id)
    if db_path is None:
        return ""
    return read_completed_response_from_db(
        db_path,
        stored_session_id,
        not_before_ms=not_before_ms,
    )


def archive_stored_session(
    profile_id: str | None, stored_session_id: str | None
) -> bool:
    """Best-effort: a turn must never fail because cosmetic cleanup did."""

    if not profile_id or not stored_session_id:
        return False
    db_path = _state_db(profile_id)
    if db_path is None:
        return False
    try:
        from hermes_state import SessionDB  # host install; absent in bare tests

        SessionDB(db_path=db_path).set_session_archived(stored_session_id, True)
        return True
    except Exception:
        _log.debug(
            "channel session archive skipped for %s/%s",
            profile_id,
            stored_session_id,
            exc_info=True,
        )
        return False


BACKFILL_FLAG = "session_visibility_backfill_v1"


def backfill_archive(repository) -> int:
    """One-time sweep: archive sessions created before turns carried the
    'tool' source. Guarded by a settings flag so it runs once per workspace;
    each archive is independently best-effort."""

    try:
        if repository.get_setting(BACKFILL_FLAG):
            return 0
        with repository.database.connect() as connection:
            rows = connection.execute(
                """SELECT DISTINCT profile_id, stored_session_id FROM turns
                   WHERE stored_session_id IS NOT NULL"""
            ).fetchall()
        # Group by profile so each state.db opens once, not once per row.
        by_profile: dict[str, list[str]] = {}
        for row in rows:
            # Classification claims carry no profile; their sessions live in
            # the default profile's store.
            by_profile.setdefault(row["profile_id"] or "default", []).append(
                row["stored_session_id"]
            )
        archived = 0
        for profile_id, session_ids in by_profile.items():
            db_path = _state_db(profile_id)
            if db_path is None:
                continue
            try:
                from hermes_state import SessionDB

                store = SessionDB(db_path=db_path)
                for session_id in session_ids:
                    try:
                        store.set_session_archived(session_id, True)
                        archived += 1
                    except Exception:
                        _log.debug(
                            "backfill archive skipped for %s/%s",
                            profile_id,
                            session_id,
                            exc_info=True,
                        )
            except Exception:
                _log.debug(
                    "backfill store unavailable for %s", profile_id, exc_info=True
                )
        # Only a full sweep sets the once-flag: a transient failure (locked
        # db, missing import) must stay retryable on the next service load.
        if archived == len(rows):
            repository.set_setting(
                BACKFILL_FLAG, {"archived": archived, "of": len(rows)}
            )
        return archived
    except Exception:
        _log.debug("channel session backfill skipped", exc_info=True)
        return 0
