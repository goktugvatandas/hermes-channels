"""SQLite connection management and schema migrations for Hermes Crew."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import time


MIGRATION_1 = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    default_responder_profile TEXT,
    default_project_json TEXT,
    allowed_projects_json TEXT NOT NULL DEFAULT '[]',
    routing_rules_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_presentation (
    profile_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    color TEXT,
    model_label TEXT,
    default_project_json TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    activation_policy TEXT NOT NULL DEFAULT 'mentioned'
        CHECK (activation_policy IN ('always', 'mentioned', 'observer', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, profile_id)
);

CREATE TABLE IF NOT EXISTS activation_rules (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    rule_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (channel_id, profile_id, version)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    root_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
    author_profile_id TEXT,
    target_profile_id TEXT,
    content TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    mentions_json TEXT NOT NULL DEFAULT '[]',
    project_json TEXT,
    intent_envelope_json TEXT,
    author_snapshot_json TEXT NOT NULL DEFAULT '{}',
    model_label TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
    ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_root_created
    ON messages(root_message_id, created_at);

CREATE TABLE IF NOT EXISTS message_recipients (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, profile_id, trigger)
);

CREATE TABLE IF NOT EXISTS threads (
    root_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    root_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    parent_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
    profile_id TEXT,
    kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'classification')),
    trigger TEXT NOT NULL,
    state TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    context TEXT NOT NULL DEFAULT '',
    project_json TEXT,
    rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
    provider TEXT,
    model TEXT,
    reasoning_effort TEXT,
    cwd TEXT,
    worker_id TEXT,
    runtime_session_id TEXT,
    stored_session_id TEXT,
    result_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    retry_of TEXT REFERENCES turns(id) ON DELETE SET NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    claimed_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_turns_state_created ON turns(state, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_channel_created ON turns(channel_id, created_at);

CREATE TABLE IF NOT EXISTS turn_edges (
    parent_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    child_turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
    source_profile_id TEXT,
    target_profile_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_turn_id, child_turn_id)
);

CREATE TABLE IF NOT EXISTS session_bindings (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    stored_session_id TEXT,
    runtime_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (channel_id, scope_id, profile_id, project_key)
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    decision TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_channel_created
    ON activity_events(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_turn_sequence
    ON activity_events(turn_id, sequence);

CREATE TABLE IF NOT EXISTS classifier_configs (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    provider TEXT,
    model TEXT,
    reasoning_effort TEXT,
    max_tokens INTEGER NOT NULL DEFAULT 300,
    confidence_threshold REAL NOT NULL DEFAULT 0.65,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pinned_context (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    root_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    reference TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
"""


class CrewDatabase:
    """Owns safe SQLite connections and forward-only Crew migrations."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    def _open(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = self._open()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _migrate(self) -> None:
        with self.connect() as connection:
            connection.executescript(MIGRATION_1)
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (1, int(time.time() * 1000)),
            )
