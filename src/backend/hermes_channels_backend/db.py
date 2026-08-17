"""SQLite connection management and schema migrations for Hermes Channels."""

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

MIGRATION_2 = """
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
    kind UNINDEXED,
    source_id UNINDEXED,
    channel_id UNINDEXED,
    member_id UNINDEXED,
    project_id UNINDEXED,
    state UNINDEXED,
    text,
    created_at UNINDEXED
);

INSERT INTO search_documents
    (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
SELECT
    'message', id, channel_id, COALESCE(author_profile_id, ''),
    COALESCE(json_extract(project_json, '$.projectId'), ''), '', content, created_at
FROM messages
-- Guard against migration replay: executescript commits version markers
-- separately, so a crash between script and marker would rerun this backfill.
WHERE NOT EXISTS (
    SELECT 1 FROM search_documents existing
    WHERE existing.kind = 'message' AND existing.source_id = messages.id
);

INSERT INTO search_documents
    (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
SELECT
    'activity', CAST(activity_events.sequence AS TEXT), activity_events.channel_id,
    COALESCE((SELECT profile_id FROM turns WHERE turns.id = activity_events.turn_id), ''),
    COALESCE(json_extract((SELECT project_json FROM turns WHERE turns.id = activity_events.turn_id), '$.projectId'), ''),
    activity_events.type, activity_events.payload_json, activity_events.created_at
FROM activity_events
WHERE NOT EXISTS (
    SELECT 1 FROM search_documents existing
    WHERE existing.kind = 'activity'
      AND existing.source_id = CAST(activity_events.sequence AS TEXT)
);

CREATE TRIGGER IF NOT EXISTS search_message_insert AFTER INSERT ON messages BEGIN
    INSERT INTO search_documents
        (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
    VALUES (
        'message', new.id, new.channel_id, COALESCE(new.author_profile_id, ''),
        COALESCE(json_extract(new.project_json, '$.projectId'), ''), '', new.content,
        new.created_at
    );
END;

CREATE TRIGGER IF NOT EXISTS search_message_delete AFTER DELETE ON messages BEGIN
    DELETE FROM search_documents WHERE kind = 'message' AND source_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_activity_insert AFTER INSERT ON activity_events BEGIN
    INSERT INTO search_documents
        (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
    VALUES (
        'activity', CAST(new.sequence AS TEXT), new.channel_id,
        COALESCE((SELECT profile_id FROM turns WHERE turns.id = new.turn_id), ''),
        COALESCE(json_extract((SELECT project_json FROM turns WHERE turns.id = new.turn_id), '$.projectId'), ''),
        new.type, new.payload_json, new.created_at
    );
END;

CREATE TRIGGER IF NOT EXISTS search_activity_delete AFTER DELETE ON activity_events BEGIN
    DELETE FROM search_documents
    WHERE kind = 'activity' AND source_id = CAST(old.sequence AS TEXT);
END;
"""



MIGRATION_3 = """
-- Turn results used to be forced into a synthetic thread under their trigger
-- even when the question was asked at channel level; answers now land where
-- the question was asked. Promote those legacy answers into the channel
-- timeline so old and new conversations read consistently.
UPDATE messages SET root_message_id = NULL
WHERE id IN (
    SELECT turns.result_message_id FROM turns
    JOIN messages AS trigger_message
      ON trigger_message.id = turns.trigger_message_id
    WHERE turns.result_message_id IS NOT NULL
      AND trigger_message.root_message_id IS NULL
      AND (
          SELECT root_message_id FROM messages
          WHERE id = turns.result_message_id
      ) = turns.trigger_message_id
      -- Only promote when the answer is the thread's sole message; threads
      -- that grew human follow-ups stay intact rather than being split.
      AND NOT EXISTS (
          SELECT 1 FROM messages AS sibling
          WHERE sibling.root_message_id = turns.trigger_message_id
            AND sibling.id != turns.result_message_id
      )
);
"""

MIGRATION_4 = """
-- Causal-lineage walks (routing budgets, session scoping) look turns up by
-- their result and trigger messages.
CREATE INDEX IF NOT EXISTS idx_turns_result_message
    ON turns(result_message_id);
CREATE INDEX IF NOT EXISTS idx_turns_trigger_message
    ON turns(trigger_message_id);
"""

MIGRATION_5 = """
-- Workspace-level key/value settings: the human user's identity (display
-- name, avatar, color) lives here rather than in member_presentation, which
-- is keyed by Hermes profile ids.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"""

MIGRATION_6 = """
-- Queued events now carry triggerExcerpt (message text) for activity
-- surfaces; indexing it verbatim made every triggering message match twice
-- in search (once as message, once as activity). Strip it from the FTS text.
DROP TRIGGER IF EXISTS search_activity_insert;
CREATE TRIGGER search_activity_insert AFTER INSERT ON activity_events BEGIN
    INSERT INTO search_documents
        (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
    VALUES (
        'activity', CAST(new.sequence AS TEXT), new.channel_id,
        COALESCE((SELECT profile_id FROM turns WHERE turns.id = new.turn_id), ''),
        COALESCE(json_extract((SELECT project_json FROM turns WHERE turns.id = new.turn_id), '$.projectId'), ''),
        new.type, json_remove(new.payload_json, '$.triggerExcerpt'), new.created_at
    );
END;

DELETE FROM search_documents WHERE kind = 'activity';
INSERT INTO search_documents
    (kind, source_id, channel_id, member_id, project_id, state, text, created_at)
SELECT 'activity', CAST(e.sequence AS TEXT), e.channel_id,
       COALESCE((SELECT profile_id FROM turns WHERE turns.id = e.turn_id), ''),
       COALESCE(json_extract((SELECT project_json FROM turns WHERE turns.id = e.turn_id), '$.projectId'), ''),
       e.type, json_remove(e.payload_json, '$.triggerExcerpt'), e.created_at
FROM activity_events e;
"""


MIGRATION_7 = """
-- Stable human-facing references (SD-1, CR-1, …) overlay Hermes' opaque
-- internal task ids without changing the host kanban schema. Mappings survive
-- card deletion so numbers are never reused.
CREATE TABLE IF NOT EXISTS kanban_card_references (
    board_slug TEXT NOT NULL,
    task_id TEXT NOT NULL,
    prefix TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_slug, task_id),
    UNIQUE (board_slug, sequence)
);
CREATE INDEX IF NOT EXISTS idx_kanban_card_references_board
    ON kanban_card_references(board_slug, sequence);

CREATE TABLE IF NOT EXISTS kanban_reference_counters (
    prefix TEXT PRIMARY KEY,
    next_sequence INTEGER NOT NULL
);
"""


class CrewDatabase:
    """Owns safe SQLite connections and forward-only Channels migrations."""

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
            applied = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 2"
            ).fetchone()
            if applied is None:
                connection.executescript(MIGRATION_2)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (2, int(time.time() * 1000)),
                )
            applied_3 = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 3"
            ).fetchone()
            if applied_3 is None:
                connection.executescript(MIGRATION_3)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (3, int(time.time() * 1000)),
                )
            applied_4 = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 4"
            ).fetchone()
            if applied_4 is None:
                connection.executescript(MIGRATION_4)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (4, int(time.time() * 1000)),
                )
            applied_5 = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 5"
            ).fetchone()
            if applied_5 is None:
                connection.executescript(MIGRATION_5)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (5, int(time.time() * 1000)),
                )
            applied_6 = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 6"
            ).fetchone()
            if applied_6 is None:
                connection.executescript(MIGRATION_6)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (6, int(time.time() * 1000)),
                )
            applied_7 = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = 7"
            ).fetchone()
            if applied_7 is None:
                connection.executescript(MIGRATION_7)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (7, int(time.time() * 1000)),
                )
