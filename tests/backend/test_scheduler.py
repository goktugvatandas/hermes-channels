import pytest

from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.event_bus import EventBus
from hermes_channels_backend.models import IntentEnvelope
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.routing import Router
from hermes_channels_backend.scheduler import Scheduler


def _scheduler_with_turn(tmp_path, event_bus=None):
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    planned = Router(repo).plan(message.id)[0]
    scheduler = Scheduler(repo, event_bus=event_bus)
    turn = scheduler.enqueue(planned)
    return repo, scheduler, turn


def test_claim_is_atomic_and_idempotent(tmp_path):
    """Only one Desktop worker may own a queued execution."""
    _, scheduler, turn = _scheduler_with_turn(tmp_path)

    first = scheduler.claim("desktop-a")
    second = scheduler.claim("desktop-b")

    assert first is not None
    assert first.id == turn.id
    assert second is None
    assert scheduler.get(turn.id).worker_id == "desktop-a"


def test_lifecycle_transitions_and_gateway_events_share_an_ordered_journal(tmp_path):
    """The activity cursor must explain each durable state transition in order."""
    repo, scheduler, turn = _scheduler_with_turn(tmp_path)
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-1", stored_session_id="s-1")
    scheduler.record_event(turn.id, "tool_started", {"name": "shell"})
    scheduler.complete(
        turn.id,
        visible_text="Done",
        envelope=IntentEnvelope(intent="result"),
    )

    assert scheduler.get(turn.id).state == "completed"
    frames = [
        frame
        for frame in scheduler.events_after(0, channel_id=turn.channel_id)
        if frame.turn_id == turn.id
    ]
    assert [frame.type for frame in frames] == [
        "queued",
        "claimed",
        "started",
        "tool_started",
        "completed",
    ]
    assert repo.require_message(scheduler.get(turn.id).result_message_id).content == "Done"


def test_failed_completion_does_not_archive_a_still_running_session(tmp_path, monkeypatch):
    repo, scheduler, turn = _scheduler_with_turn(tmp_path)
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id, runtime_session_id="runtime-1", stored_session_id="stored-1"
    )
    archived = []
    monkeypatch.setattr(scheduler, "_archive_turn_session", archived.append)
    monkeypatch.setattr(
        repo, "append_message", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("write failed"))
    )

    with pytest.raises(RuntimeError, match="write failed"):
        scheduler.complete(
            turn.id,
            visible_text="Done",
            envelope=IntentEnvelope(intent="result"),
        )

    assert archived == []
    assert scheduler.get(turn.id).state == "running"


def test_approval_resolution_returns_waiting_turn_to_running(tmp_path):
    """Approval decisions must resume the same turn without creating a child."""
    _, scheduler, turn = _scheduler_with_turn(tmp_path)
    scheduler.claim("desktop-a")
    scheduler.bind_session(turn.id, runtime_session_id="runtime-1")
    approval = scheduler.record_event(
        turn.id,
        "approval_request",
        {"requestId": "approval-1", "prompt": "Allow command?"},
    )

    waiting = scheduler.events_after(0, channel_id=turn.channel_id)[-1]
    assert waiting.type == "waiting_approval"
    assert waiting.payload["approvalId"] == approval.id

    scheduler.resolve_approval(approval.id, decision="reject", note="not now")

    assert scheduler.get(turn.id).state == "running"
    assert scheduler.get(turn.id).parent_turn_id is None


def test_retry_creates_a_new_turn_without_reopening_the_old_one(tmp_path):
    """Explicit retry must preserve immutable terminal history."""
    _, scheduler, turn = _scheduler_with_turn(tmp_path)
    scheduler.cancel(turn.id)

    retry = scheduler.retry(turn.id)

    assert scheduler.get(turn.id).state == "cancelled"
    assert retry.id != turn.id
    assert retry.retry_of == turn.id
    assert retry.state == "queued"


@pytest.mark.asyncio
async def test_event_bus_receives_the_same_frame_persisted_for_polling(tmp_path):
    """Socket acceleration and cursor polling must expose identical event frames."""
    bus = EventBus()
    queue = bus.subscribe()
    _, scheduler, turn = _scheduler_with_turn(tmp_path, event_bus=bus)

    pushed = await queue.get()
    polled = scheduler.events_after(pushed.sequence - 1)[0]
    bus.unsubscribe(queue)

    assert pushed == polled
    assert pushed.turn_id == turn.id
