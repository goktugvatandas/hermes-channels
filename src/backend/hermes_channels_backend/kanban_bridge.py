"""In-process bridge to the host Hermes kanban store, surfaced per channel.

Hermes already owns the coordination primitive — free-standing kanban boards
under ``<root>/kanban/boards/<slug>/`` shared across every profile, with all
fourteen agent kanban tools writing to them. Channels therefore does not grow
its own card store: each channel maps to one host board (``channel-<name>`` by
convention, overridable), and this bridge performs the reads/writes through
``hermes_cli.kanban_db`` inside the dashboard process — the same pattern
:mod:`hermes_adapter` uses for profiles and projects.
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace
from typing import Any


#: settings key holding explicit channel-id → board-slug overrides.
BOARD_MAP_SETTING = "kanban_board_map"

#: Board statuses surfaced to the UI, in column order. ``archived`` is
#: intentionally absent — archived cards are the board's trash can.
CARD_STATUSES = (
    "triage",
    "todo",
    "scheduled",
    "ready",
    "running",
    "blocked",
    "review",
    "done",
)


def default_board_slug(channel_name: str) -> str:
    """Convention shared with `hermes kanban boards create channel-<name>`."""

    return f"channel-{channel_name}"


def _load_bindings() -> SimpleNamespace:
    """Import the host kanban store lazily so tests can run without Hermes."""

    kanban_db = importlib.import_module("hermes_cli.kanban_db")
    return SimpleNamespace(
        connect_closing=kanban_db.connect_closing,
        board_exists=kanban_db.board_exists,
        create_board=kanban_db.create_board,
        read_board_metadata=kanban_db.read_board_metadata,
        list_tasks=kanban_db.list_tasks,
        get_task=kanban_db.get_task,
        create_task=kanban_db.create_task,
        complete_task=kanban_db.complete_task,
        block_task=kanban_db.block_task,
        unblock_task=kanban_db.unblock_task,
        add_comment=kanban_db.add_comment,
        list_comments=kanban_db.list_comments,
        list_events=kanban_db.list_events,
        delete_task=kanban_db.delete_task,
        list_boards=kanban_db.list_boards,
        assign_task=kanban_db.assign_task,
        notify_task_updated=kanban_db.notify_task_updated,
        set_current_board=kanban_db.set_current_board,
    )


def _card(task: Any) -> dict[str, Any]:
    return {
        "id": task.id,
        "title": task.title,
        "body": task.body,
        "status": task.status,
        "assignee": task.assignee,
        "priority": task.priority,
        "createdBy": task.created_by,
        "projectId": task.project_id,
        "result": task.result,
        "blockKind": getattr(task, "block_kind", None),
        "tenant": task.tenant,
        "branchName": getattr(task, "branch_name", None),
        "workspaceKind": task.workspace_kind,
        "workspacePath": task.workspace_path,
        "modelOverride": getattr(task, "model_override", None),
        "providerOverride": getattr(task, "provider_override", None),
        "reasoningEffort": getattr(task, "reasoning_effort", None),
        "skills": getattr(task, "skills", None),
        "goalMode": bool(getattr(task, "goal_mode", False)),
        "consecutiveFailures": getattr(task, "consecutive_failures", 0),
        "lastFailureError": getattr(task, "last_failure_error", None),
        "maxRuntimeSeconds": getattr(task, "max_runtime_seconds", None),
        "lastHeartbeatAt": getattr(task, "last_heartbeat_at", None),
        "sessionId": getattr(task, "session_id", None),
        "createdAt": task.created_at,
        "startedAt": task.started_at,
        "completedAt": task.completed_at,
    }


def _event(event: Any) -> dict[str, Any]:
    return {
        "id": event.id,
        "kind": event.kind,
        "payload": event.payload,
        "createdAt": event.created_at,
    }


def _comment(comment: Any) -> dict[str, Any]:
    return {
        "id": comment.id,
        "author": comment.author,
        "body": comment.body,
        "createdAt": comment.created_at,
    }


class KanbanBridge:
    """Channel-scoped operations over one host kanban board."""

    def __init__(self, bindings: Any | None = None):
        self._bindings = bindings

    @property
    def bindings(self) -> Any:
        if self._bindings is None:
            self._bindings = _load_bindings()
        return self._bindings

    @property
    def available(self) -> bool:
        try:
            return self.bindings is not None
        except Exception:
            return False

    def ensure_board(self, slug: str, *, display_name: str | None = None) -> None:
        if not self.bindings.board_exists(board=slug):
            # mkdir -p semantics upstream; racing creators are harmless.
            self.bindings.create_board(slug, name=display_name or slug)

    def board_exists(self, slug: str) -> bool:
        return bool(self.bindings.board_exists(board=slug))

    def list_boards(self) -> list[dict[str, Any]]:
        """Host boards a channel can connect to, active ones only."""

        boards = self.bindings.list_boards(include_archived=False)
        return [
            {"slug": board.get("slug"), "name": board.get("name") or board.get("slug")}
            for board in boards
            if board.get("slug")
        ]

    def switch_current_board(self, slug: str) -> None:
        """Make `slug` the host's current board — what the official Kanban
        page renders when the user hasn't pinned a board of their own. This is
        the deep-link half of "open this channel's board in the full Kanban
        UI"; it is exactly `hermes kanban boards switch <slug>`."""

        self.bindings.set_current_board(slug)

    def assign_card(self, slug: str, task_id: str, assignee: str | None) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            try:
                assigned = self.bindings.assign_task(conn, task_id, assignee)
            except RuntimeError as exc:  # running+claimed → a client error, not a 500
                raise ValueError(str(exc)) from exc
            if not assigned:
                raise KeyError(f"unknown card: {task_id}")
            return _card(self.bindings.get_task(conn, task_id))

    def snapshot(self, slug: str) -> dict[str, Any]:
        meta = self.bindings.read_board_metadata(board=slug) or {}
        with self.bindings.connect_closing(board=slug) as conn:
            tasks = self.bindings.list_tasks(conn)
            counts = dict(
                conn.execute(
                    "SELECT task_id, COUNT(*) FROM task_comments GROUP BY task_id"
                ).fetchall()
            )
        cards = []
        for task in tasks:
            if task.status not in CARD_STATUSES:
                continue
            card = _card(task)
            card["commentCount"] = int(counts.get(task.id, 0))
            cards.append(card)
        return {
            "boardSlug": slug,
            "boardName": meta.get("name") or slug,
            "statuses": list(CARD_STATUSES),
            "cards": cards,
        }

    def get_card(self, slug: str, task_id: str) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            task = self.bindings.get_task(conn, task_id)
            if task is None:
                raise KeyError(f"unknown card: {task_id}")
            comments = self.bindings.list_comments(conn, task_id)
            events = self.bindings.list_events(conn, task_id)
            links = conn.execute(
                "SELECT parent_id, child_id FROM task_links"
                " WHERE parent_id = ? OR child_id = ?",
                (task_id, task_id),
            ).fetchall()
        payload = _card(task)
        payload["comments"] = [_comment(item) for item in comments]
        payload["events"] = [_event(item) for item in events[-30:]]
        payload["parents"] = [row[0] for row in links if row[1] == task_id]
        payload["children"] = [row[1] for row in links if row[0] == task_id]
        # Surface the human-entered block reason without making the UI dig
        # through the event log for it.
        payload["blockReason"] = next(
            (
                (event.payload or {}).get("reason")
                for event in reversed(events)
                if event.kind == "blocked" and isinstance(event.payload, dict)
            ),
            None,
        )
        return payload

    def create_card(
        self,
        slug: str,
        *,
        title: str,
        body: str | None = None,
        assignee: str | None = None,
        priority: int = 0,
        triage: bool = False,
        created_by: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            task_id = self.bindings.create_task(
                conn,
                title=title,
                body=body,
                assignee=assignee,
                priority=priority,
                triage=triage,
                created_by=created_by,
                idempotency_key=idempotency_key,
            )
            task = self.bindings.get_task(conn, task_id)
        return _card(task)

    def complete_card(self, slug: str, task_id: str, *, result: str | None = None) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            if not self.bindings.complete_task(conn, task_id, result=result):
                raise ValueError(f"card cannot be completed from its current state: {task_id}")
            return _card(self.bindings.get_task(conn, task_id))

    def block_card(self, slug: str, task_id: str, *, reason: str | None = None) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            if not self.bindings.block_task(conn, task_id, reason=reason):
                raise ValueError(f"card cannot be blocked from its current state: {task_id}")
            return _card(self.bindings.get_task(conn, task_id))

    def unblock_card(self, slug: str, task_id: str) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            if not self.bindings.unblock_task(conn, task_id):
                raise ValueError(f"card is not blocked: {task_id}")
            return _card(self.bindings.get_task(conn, task_id))

    def edit_card(
        self,
        slug: str,
        task_id: str,
        *,
        title: str | None = None,
        body: str | None = None,
        priority: int | None = None,
    ) -> dict[str, Any]:
        """Edit a card's title/body/priority.

        The host store has no mutator for these — its own dashboard editors
        write direct SQL and fire ``notify_task_updated`` afterwards (the
        pattern that function's docstring documents), so we do the same and
        record an ``edited`` event to keep the card's history honest.
        """

        changes: dict[str, Any] = {}
        if title is not None:
            if not title.strip():
                raise ValueError("title cannot be empty")
            changes["title"] = title.strip()
        if body is not None:
            changes["body"] = body
        if priority is not None:
            changes["priority"] = int(priority)
        if not changes:
            return self.get_card(slug, task_id)
        import json as _json
        import time as _time

        with self.bindings.connect_closing(board=slug) as conn:
            if self.bindings.get_task(conn, task_id) is None:
                raise KeyError(f"unknown card: {task_id}")
            assignments = ", ".join(f"{column} = ?" for column in changes)
            with conn:
                conn.execute(
                    f"UPDATE tasks SET {assignments} WHERE id = ?",
                    (*changes.values(), task_id),
                )
                conn.execute(
                    "INSERT INTO task_events (task_id, kind, payload, created_at)"
                    " VALUES (?, 'edited', ?, ?)",
                    (task_id, _json.dumps({"fields": sorted(changes)}), int(_time.time())),
                )
            self.bindings.notify_task_updated(conn, task_id, tuple(changes))
            return _card(self.bindings.get_task(conn, task_id))

    def comment_card(self, slug: str, task_id: str, *, author: str, body: str) -> dict[str, Any]:
        with self.bindings.connect_closing(board=slug) as conn:
            self.bindings.add_comment(conn, task_id, author, body)
        return self.get_card(slug, task_id)

    def delete_card(self, slug: str, task_id: str) -> None:
        with self.bindings.connect_closing(board=slug) as conn:
            if not self.bindings.delete_task(conn, task_id):
                raise KeyError(f"unknown card: {task_id}")
