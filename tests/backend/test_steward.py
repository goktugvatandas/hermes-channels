"""The Steward unblocks stalled agent lifecycles without breaking budgets."""

import time

from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.repositories import CrewRepository
from hermes_crew_backend.routing import Router
from hermes_crew_backend.scheduler import Scheduler
from hermes_crew_backend.steward import Steward, load_settings, save_settings


def _stalled_handoff(tmp_path):
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "freya")
    message = repo.append_message(
        channel.id,
        "agent",
        "@freya please analyze the edge cases.",
        author_profile_id="athena",
        intent_envelope={
            "schemaVersion": 1,
            "intent": "handoff",
            "recipients": ["freya"],
            "replyExpected": True,
            "replyBudget": 1,
            "correlationId": None,
            "summary": "",
        },
    )
    # Simulate the stall: the message exists but routing never ran for it
    # (e.g. the completing worker died right after posting).
    stale = int(time.time() * 1000) - 10 * 60 * 1000
    with repo.database.connect() as connection:
        connection.execute("UPDATE messages SET created_at = ?", (stale,))
    scheduler = Scheduler(repo)
    return repo, scheduler, Steward(repo, scheduler, scheduler.router), message


def test_sweep_replans_unserved_handoffs_idempotently(tmp_path):
    repo, scheduler, steward, message = _stalled_handoff(tmp_path)

    first = steward.sweep(stall_ms=5 * 60 * 1000)
    assert first["replanned"] == [f"{message.id[:8]}->freya"]

    # A second sweep sees the recipient served and does nothing.
    second = steward.sweep(stall_ms=5 * 60 * 1000)
    assert second["replanned"] == []
    with repo.database.connect() as connection:
        count = connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
    assert count == 1


def test_maybe_sweep_respects_enabled_flag_and_interval(tmp_path):
    repo, scheduler, steward, message = _stalled_handoff(tmp_path)

    # Disabled by default: nothing happens.
    steward.maybe_sweep()
    with repo.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 0

    save_settings(repo, {"enabled": True, "stallMinutes": 5})
    steward.maybe_sweep()
    with repo.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1

    assert load_settings(repo)["enabled"] is True


def test_judgment_turn_enqueued_once_and_wake_respects_caps(tmp_path):
    """With a model configured, an ambiguous stall gets exactly one judgment
    turn; its verdict wakes the named member through the normal caps."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "freya")
    message = repo.append_message(
        channel.id,
        "agent",
        "I'll spawn subagents for the workstreams.",
        author_profile_id="athena",
        intent_envelope={"schemaVersion": 1, "intent": "inform"},
    )
    stale = int(time.time() * 1000) - 10 * 60 * 1000
    with repo.database.connect() as connection:
        connection.execute("UPDATE messages SET created_at = ?", (stale,))
    scheduler = Scheduler(repo)
    steward = Steward(repo, scheduler, scheduler.router)

    first = steward.sweep(stall_ms=5 * 60 * 1000, provider="zai", model="glm-4.5-flash")
    assert first["judged"] == [message.id[:8]]
    # Idempotent: a second sweep enqueues nothing new.
    assert steward.sweep(stall_ms=5 * 60 * 1000, provider="zai", model="glm-4.5-flash")["judged"] == []

    claim = scheduler.claim("worker-1")
    assert claim is not None and claim.kind == "classification"
    assert "Steward" in (claim.instructions or "")

    woken = scheduler.complete_classification(
        claim.id, '{"respond": true, "wake": ["freya"], "confidence": 0.9}'
    )
    assert [(turn.profile_id, turn.trigger) for turn in woken] == [("freya", "steward")]


def test_judgment_verdict_false_wakes_nobody(tmp_path):
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "freya")
    repo.append_message(
        channel.id,
        "agent",
        "All wrapped up here.",
        author_profile_id="athena",
        intent_envelope={"schemaVersion": 1, "intent": "inform"},
    )
    stale = int(time.time() * 1000) - 10 * 60 * 1000
    with repo.database.connect() as connection:
        connection.execute("UPDATE messages SET created_at = ?", (stale,))
    scheduler = Scheduler(repo)
    steward = Steward(repo, scheduler, scheduler.router)
    steward.sweep(stall_ms=5 * 60 * 1000, provider="zai", model="glm-4.5-flash")
    claim = scheduler.claim("worker-1")
    assert claim is not None
    assert scheduler.complete_classification(
        claim.id, '{"respond": false, "wake": [], "confidence": 0.9}'
    ) == []


def test_sweep_reports_budget_blocked_wakes(tmp_path):
    """When routing refuses a replanned wake (loop budget), the sweep says so
    instead of pretending nothing was stuck."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel(
        "general", routing_rules={"max_automated_turns": 0}
    )
    repo.add_member(channel.id, "athena")
    message = repo.append_message(
        channel.id,
        "agent",
        "Returning the docs blurb.",
        author_profile_id="thoth",
        intent_envelope={
            "schemaVersion": 1,
            "intent": "result",
            "recipients": ["athena"],
        },
    )
    stale = int(time.time() * 1000) - 10 * 60 * 1000
    with repo.database.connect() as connection:
        connection.execute("UPDATE messages SET created_at = ?", (stale,))
    scheduler = Scheduler(repo)
    steward = Steward(repo, scheduler, scheduler.router)

    result = steward.sweep(stall_ms=5 * 60 * 1000)
    assert result["replanned"] == []
    assert result["blocked"] == [f"{message.id[:8]}->athena"]
