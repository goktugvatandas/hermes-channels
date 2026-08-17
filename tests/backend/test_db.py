import sqlite3

import pytest

from hermes_channels_backend.db import CrewDatabase


REQUIRED_TABLES = {
    "activation_rules",
    "activity_events",
    "approvals",
    "attachments",
    "channel_members",
    "channels",
    "classifier_configs",
    "member_presentation",
    "message_recipients",
    "messages",
    "kanban_card_references",
    "kanban_reference_counters",
    "pinned_context",
    "schema_migrations",
    "session_bindings",
    "threads",
    "turn_edges",
    "turns",
}


def test_migration_enables_sqlite_safety_and_creates_domain_tables(tmp_path):
    """A fresh database must enforce FKs, WAL, and the complete v1 schema."""
    db = CrewDatabase(tmp_path / "channels.db")

    with db.connect() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }

    assert REQUIRED_TABLES <= names


def test_message_idempotency_key_is_unique(tmp_path):
    """A reconnect must not persist the same human command twice."""
    db = CrewDatabase(tmp_path / "channels.db")

    with db.connect() as conn:
        conn.execute(
            "INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ("a" * 32, "general", 1, 1),
        )
        values = ("b" * 32, "a" * 32, "user", "first", "same-key", 2)
        conn.execute(
            """INSERT INTO messages
               (id, channel_id, author_type, content, idempotency_key, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            values,
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """INSERT INTO messages
                   (id, channel_id, author_type, content, idempotency_key, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                ("c" * 32, "a" * 32, "user", "duplicate", "same-key", 3),
            )
