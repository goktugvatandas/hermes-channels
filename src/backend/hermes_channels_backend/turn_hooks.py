"""Durable Hermes lifecycle-hook bridge for channel worker turns.

The Desktop worker still mirrors live gateway events for progress UI, but final
turn delivery must not depend on a renderer staying mounted long enough to see
``message.complete``. Hermes' host-owned lifecycle hooks run inside the agent
process, so they are the authoritative completion path; the Desktop completion
POST remains an idempotent compatibility fallback.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .db import CrewDatabase
from .intent import parse_agent_output
from .repositories import CrewRepository
from .scheduler import Scheduler
from .session_visibility import read_completed_response_from_db

_log = logging.getLogger(__name__)
_ACTIVE_STATES = ("claimed", "running", "waiting_approval")


def _shared_database_path() -> Path:
    """Resolve the owner-profile Channels DB, ignoring task-local profile scope."""

    try:
        from hermes_constants import get_process_hermes_home

        home = Path(get_process_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return home / "channels" / "channels.db"


def _current_profile_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _repository(database_path: str | Path | None = None) -> CrewRepository | None:
    path = Path(database_path) if database_path is not None else _shared_database_path()
    if not path.is_file():
        return None
    return CrewRepository(CrewDatabase(path))


def _bound_turn_id(repository: CrewRepository, session_id: str) -> str | None:
    with repository.database.connect() as connection:
        row = connection.execute(
            """SELECT id FROM turns
               WHERE stored_session_id = ? AND kind = 'agent'
               ORDER BY CASE
                   WHEN state IN ('claimed', 'running', 'waiting_approval') THEN 0
                   WHEN state = 'completed' THEN 1
                   ELSE 2
               END, created_at DESC, id DESC
               LIMIT 1""",
            (session_id,),
        ).fetchone()
    return str(row["id"]) if row is not None else None


def _current_turn_output(
    assistant_response: str,
    conversation_history: list[dict[str, Any]] | None,
) -> str:
    if not conversation_history:
        return assistant_response
    last_user = max(
        (
            index
            for index, message in enumerate(conversation_history)
            if message.get("role") == "user"
        ),
        default=-1,
    )
    parts = [
        str(message.get("content") or "").strip()
        for message in conversation_history[last_user + 1 :]
        if message.get("role") == "assistant"
        and isinstance(message.get("content"), str)
        and str(message.get("content") or "").strip()
    ]
    final = assistant_response.strip()
    if final and (not parts or parts[-1] != final):
        parts.append(final)
    return "\n\n".join(parts) if parts else assistant_response


def persist_channel_response(
    *,
    session_id: str,
    assistant_response: str,
    conversation_history: list[dict[str, Any]] | None = None,
    database_path: str | Path | None = None,
    completion_source: str = "post_llm_call",
    **_: Any,
) -> bool:
    """Complete the channel turn bound to ``session_id`` from Hermes' final hook.

    Returns ``True`` when this is a channel session and its response is already
    or newly durable. Non-channel sessions are ignored. Every exception is
    isolated because hooks must never break the host agent's own delivery.
    """

    if not session_id or not assistant_response:
        return False
    try:
        repository = _repository(database_path)
        if repository is None:
            return False
        turn_id = _bound_turn_id(repository, session_id)
        if turn_id is None:
            return False
        scheduler = Scheduler(repository)
        turn = scheduler.get(turn_id)
        if turn.state == "completed" and turn.result_message_id:
            return True
        if turn.state not in _ACTIVE_STATES:
            return False
        full_response = _current_turn_output(
            assistant_response,
            conversation_history,
        )
        visible_text, envelope = parse_agent_output(full_response)
        if not visible_text:
            return False
        scheduler.complete(
            turn_id,
            visible_text=visible_text,
            envelope=envelope,
            source=completion_source,
        )
        return True
    except Exception:
        _log.warning(
            "Hermes Channels could not persist final response for session %s",
            session_id,
            exc_info=True,
        )
        return False


def _latest_assistant_response(
    profile_home: Path,
    session_id: str,
    *,
    not_before_ms: int,
) -> str:
    state_db = profile_home / "state.db"
    if not state_db.is_file():
        return ""
    return read_completed_response_from_db(
        state_db,
        session_id,
        not_before_ms=not_before_ms,
    )


def on_channel_session_end(
    *,
    session_id: str,
    completed: bool,
    interrupted: bool,
    database_path: str | Path | None = None,
    profile_home: str | Path | None = None,
    **_: Any,
) -> bool:
    """Backstop final delivery from the persisted transcript at turn end."""

    if not completed or interrupted or not session_id:
        return False
    repository = _repository(database_path)
    if repository is None:
        return False
    turn_id = _bound_turn_id(repository, session_id)
    if turn_id is None:
        return False
    turn = Scheduler(repository).get(turn_id)
    if turn.state == "completed" and turn.result_message_id:
        return True
    if turn.state not in _ACTIVE_STATES:
        return False
    response = _latest_assistant_response(
        Path(profile_home) if profile_home is not None else _current_profile_home(),
        session_id,
        not_before_ms=turn.created_at,
    )
    if not response:
        return False
    return persist_channel_response(
        session_id=session_id,
        assistant_response=response,
        database_path=database_path,
        completion_source="on_session_end",
    )


def on_channel_stream_boundary(
    *,
    session_id: str,
    database_path: str | Path | None = None,
    **_: Any,
) -> bool:
    """Use host-owned stream lifecycle events as an additional liveness beat."""

    if not session_id:
        return False
    try:
        repository = _repository(database_path)
        if repository is None:
            return False
        turn_id = _bound_turn_id(repository, session_id)
        if turn_id is None:
            return False
        return Scheduler(repository).heartbeat(turn_id)
    except Exception:
        _log.debug(
            "Hermes Channels stream heartbeat failed for session %s",
            session_id,
            exc_info=True,
        )
        return False
