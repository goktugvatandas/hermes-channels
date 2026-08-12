from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.repositories import CrewRepository
from hermes_crew_backend.routing import Router


def _intent(intent: str, recipients: list[str] | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "intent": intent,
        "recipients": recipients or [],
        "replyExpected": intent in {"reply_required", "handoff", "review_request"},
        "replyBudget": 1 if recipients else 0,
        "correlationId": None,
        "summary": "",
    }


def test_agent_inform_does_not_wake_default_or_always_responders(tmp_path):
    """An announcement from one agent must terminate unless it names a reply."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas", activation_policy="always")
    repo.add_member(channel.id, "critic", activation_policy="always")
    message = repo.append_message(
        channel.id,
        "agent",
        "Done.",
        author_profile_id="scout",
        intent_envelope=_intent("inform"),
    )

    assert Router(repo).plan(message.id) == []


def test_review_wakes_named_reviewer_once(tmp_path):
    """A valid review request must schedule exactly the named member."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("development")
    repo.add_member(channel.id, "critic")
    message = repo.append_message(
        channel.id,
        "agent",
        "Please review.",
        author_profile_id="atlas",
        intent_envelope=_intent("review_request", ["critic"]),
    )

    turns = Router(repo).plan(message.id)

    assert [(turn.profile_id, turn.trigger) for turn in turns] == [
        ("critic", "intent:review_request")
    ]


def test_human_routing_preserves_precedence_and_collapses_duplicates(tmp_path):
    """Mention, default, and always rules must produce one turn per profile."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas", activation_policy="always")
    repo.add_member(channel.id, "scout", activation_policy="mentioned")
    repo.add_member(channel.id, "critic", activation_policy="always")
    message = repo.append_message(
        channel.id, "user", "@scout investigate", mentions=["scout", "atlas"]
    )

    turns = Router(repo).plan(message.id)

    assert [turn.profile_id for turn in turns] == ["scout", "atlas", "critic"]
    assert turns[1].triggers == ("mention", "default", "always")


def test_repeated_directed_pair_is_blocked_and_journaled(tmp_path):
    """A second Atlas-to-Critic transition in one chain must stop the loop."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("development", routing_rules={"max_depth": 10})
    repo.add_member(channel.id, "atlas")
    repo.add_member(channel.id, "critic")
    root = repo.append_message(channel.id, "user", "implement and review")
    first = repo.append_message(
        channel.id,
        "agent",
        "review this",
        root_message_id=root.id,
        author_profile_id="atlas",
        intent_envelope=_intent("review_request", ["critic"]),
    )
    assert [turn.profile_id for turn in Router(repo).plan(first.id)] == ["critic"]
    second = repo.append_message(
        channel.id,
        "agent",
        "please revise",
        root_message_id=root.id,
        author_profile_id="critic",
        intent_envelope=_intent("handoff", ["atlas"]),
    )
    assert [turn.profile_id for turn in Router(repo).plan(second.id)] == ["atlas"]
    third = repo.append_message(
        channel.id,
        "agent",
        "review again",
        root_message_id=root.id,
        author_profile_id="atlas",
        intent_envelope=_intent("review_request", ["critic"]),
    )
    router = Router(repo)

    assert router.plan(third.id) == []
    assert router.decisions_for(third.id)[-1].disposition == "loop_blocked"
