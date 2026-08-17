from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.routing import Router
from hermes_channels_backend.scheduler import Scheduler


def test_restart_marks_orphaned_running_turn_interrupted(tmp_path):
    """Crew must never silently replay work whose Desktop runtime disappeared."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-gone")

    interrupted = scheduler.reconcile_startup(active_runtime_ids=set(), stale_after_ms=0)

    assert interrupted == [turn.id]
    recovered = scheduler.get(turn.id)
    assert recovered.state == "interrupted"
    assert recovered.retry_of is None


def test_restart_recovers_a_persisted_final_response_before_interrupting(tmp_path):
    """A renderer/process crash after the model finished must not lose the reply."""
    import os
    from pathlib import Path
    import sqlite3

    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id,
        runtime_session_id="runtime-gone",
        stored_session_id="stored-finished",
    )

    profile_home = Path(os.environ["HERMES_HOME"]) / "profiles" / "atlas"
    profile_home.mkdir(parents=True)
    with sqlite3.connect(profile_home / "state.db") as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.execute(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, 'assistant', ?, 'stop', ?)",
            (
                "stored-finished",
                "Recovered answer\n\n"
                '[[hermes-channels:intent {"schemaVersion":1,"intent":"result"}]]',
                turn.created_at / 1000 + 1,
            ),
        )

    assert scheduler.reconcile_startup(set(), stale_after_ms=0) == []
    recovered = scheduler.get(turn.id)
    assert recovered.state == "completed"
    assert repo.require_message(recovered.result_message_id).content == "Recovered answer"


def test_restart_recovers_multi_message_prose_plus_trailing_marker(tmp_path):
    import os
    from pathlib import Path
    import sqlite3

    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id,
        runtime_session_id="runtime-gone",
        stored_session_id="stored-multi",
    )

    profile_home = Path(os.environ["HERMES_HOME"]) / "profiles" / "atlas"
    profile_home.mkdir(parents=True)
    marker = '[[hermes-channels:intent {"schemaVersion":1,"intent":"result"}]]'
    with sqlite3.connect(profile_home / "state.db") as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.executemany(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, ?, ?, ?, ?)",
            [
                ("stored-multi", "user", "build it", None, turn.created_at / 1000),
                ("stored-multi", "assistant", "Completed work", "tool_calls", turn.created_at / 1000 + 1),
                ("stored-multi", "tool", "tool result", None, turn.created_at / 1000 + 2),
                ("stored-multi", "assistant", marker, "stop", turn.created_at / 1000 + 3),
            ],
        )

    assert scheduler.reconcile_startup(set(), stale_after_ms=0) == []
    recovered = scheduler.get(turn.id)
    assert recovered.state == "completed"
    assert repo.require_message(recovered.result_message_id).content == "Completed work"


def test_restart_never_replays_a_previous_response_from_a_reused_session(tmp_path):
    import os
    from pathlib import Path
    import sqlite3

    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "new request")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id,
        runtime_session_id="runtime-gone",
        stored_session_id="reused-session",
    )

    profile_home = Path(os.environ["HERMES_HOME"]) / "profiles" / "atlas"
    profile_home.mkdir(parents=True)
    with sqlite3.connect(profile_home / "state.db") as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.execute(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, 'assistant', 'Prior answer', 'stop', ?)",
            ("reused-session", turn.created_at / 1000 - 1),
        )

    assert scheduler.reconcile_startup(set(), stale_after_ms=0) == [turn.id]
    assert scheduler.get(turn.id).state == "interrupted"
    with repo.database.connect() as connection:
        assert connection.execute(
            "select count(*) from messages where parent_message_id = ?",
            (turn.trigger_message_id,),
        ).fetchone()[0] == 0


def test_restart_does_not_finalize_stop_followed_by_later_turn_activity(tmp_path):
    import os
    from pathlib import Path
    import sqlite3

    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "verify before finishing")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id,
        runtime_session_id="runtime-gone",
        stored_session_id="continued-session",
    )

    profile_home = Path(os.environ["HERMES_HOME"]) / "profiles" / "atlas"
    profile_home.mkdir(parents=True)
    with sqlite3.connect(profile_home / "state.db") as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.executemany(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, ?, ?, ?, ?)",
            [
                ("continued-session", "user", "verify", None, turn.created_at / 1000),
                ("continued-session", "assistant", "Provisional answer", "stop", turn.created_at / 1000 + 1),
                ("continued-session", "tool", "verification still running", None, turn.created_at / 1000 + 2),
            ],
        )

    assert scheduler.reconcile_startup(set(), stale_after_ms=0) == [turn.id]
    assert scheduler.get(turn.id).state == "interrupted"


def test_restart_keeps_a_confirmed_runtime_running(tmp_path):
    """A runtime confirmed by Hermes must not be interrupted during recovery."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-live")

    assert scheduler.reconcile_startup(
        active_runtime_ids={"runtime-live"}, stale_after_ms=0
    ) == []
    assert scheduler.get(turn.id).state == "running"


def test_second_host_boot_leaves_live_turns_alone(tmp_path):
    """Both hosts share channels.db: a booting backend must not interrupt a turn
    another host's worker is actively driving (regression: it blanket-reaped
    everything in flight, killing cross-host relays mid-run)."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-live")

    # The second host knows nothing about active runtimes — exactly how
    # BackendServices.load() calls it — but the turn has fresh journal
    # activity, so default staleness keeps it running.
    assert scheduler.reconcile_startup(active_runtime_ids=set()) == []
    assert scheduler.get(turn.id).state == "running"


def test_heartbeat_keeps_silent_turn_alive_and_reap_still_catches_dead_ones(tmp_path):
    """A worker heartbeat must protect a journal-silent turn (reasoning models
    stream nothing for minutes); without beats the stale reap still fires."""
    import sqlite3 as _sqlite3
    import time as _time

    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "think hard")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")

    # Backdate all journal traces past the stale window.
    stale = int(_time.time() * 1000) - 30 * 60 * 1000
    with _sqlite3.connect(tmp_path / "channels.db") as connection:
        connection.execute("UPDATE turns SET updated_at = ?", (stale,))
        connection.execute("UPDATE activity_events SET created_at = ?", (stale,))

    # A heartbeat refreshes liveness: the reap leaves the turn alone.
    assert scheduler.heartbeat(turn.id) is True
    assert scheduler.reconcile_startup(set()) == []
    assert scheduler.get(turn.id).state == "claimed"

    # Silence again -> reaped.
    with _sqlite3.connect(tmp_path / "channels.db") as connection:
        connection.execute("UPDATE turns SET updated_at = ?", (stale,))
    assert scheduler.reconcile_startup(set()) == [turn.id]
    assert scheduler.get(turn.id).state == "interrupted"
    # Heartbeats on settled turns are refused.
    assert scheduler.heartbeat(turn.id) is False
