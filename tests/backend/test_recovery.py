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
