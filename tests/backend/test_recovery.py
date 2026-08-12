from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.repositories import CrewRepository
from hermes_crew_backend.routing import Router
from hermes_crew_backend.scheduler import Scheduler


def test_restart_marks_orphaned_running_turn_interrupted(tmp_path):
    """Crew must never silently replay work whose Desktop runtime disappeared."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-gone")

    interrupted = scheduler.reconcile_startup(active_runtime_ids=set())

    assert interrupted == [turn.id]
    recovered = scheduler.get(turn.id)
    assert recovered.state == "interrupted"
    assert recovered.retry_of is None


def test_restart_keeps_a_confirmed_runtime_running(tmp_path):
    """A runtime confirmed by Hermes must not be interrupted during recovery."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-live")

    assert scheduler.reconcile_startup(active_runtime_ids={"runtime-live"}) == []
    assert scheduler.get(turn.id).state == "running"
