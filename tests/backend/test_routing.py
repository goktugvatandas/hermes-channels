from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.repositories import CrewRepository
from hermes_crew_backend.routing import Router


def _intent(intent: str, recipients: list[str] | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "intent": intent,
        "recipients": recipients or [],
        "replyExpected": intent in {"reply_required", "handoff", "review_request", "question"},
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


def _link_turn(repo: CrewRepository, trigger_id: str, result_id: str, profile: str) -> None:
    """Record the causal turn that produced `result_id` from `trigger_id`.

    The router walks turns' trigger->result lineage (not thread containment),
    matching how the scheduler records production turns.
    """
    with repo.database.connect() as connection:
        connection.execute(
            """INSERT INTO turns (
                   id, channel_id, trigger_message_id, profile_id, trigger,
                   state, idempotency_key, result_message_id, created_at, updated_at
               ) SELECT ?, channel_id, ?, ?, 'mention', 'completed', ?, ?, created_at, created_at
                 FROM messages WHERE id = ?""",
            (
                f"turn-{result_id}",
                trigger_id,
                profile,
                f"turn-{result_id}",
                result_id,
                result_id,
            ),
        )


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
        author_profile_id="atlas",
        intent_envelope=_intent("review_request", ["critic"]),
    )
    _link_turn(repo, root.id, first.id, "atlas")
    assert [turn.profile_id for turn in Router(repo).plan(first.id)] == ["critic"]
    second = repo.append_message(
        channel.id,
        "agent",
        "please revise",
        author_profile_id="critic",
        intent_envelope=_intent("handoff", ["atlas"]),
    )
    _link_turn(repo, first.id, second.id, "critic")
    assert [turn.profile_id for turn in Router(repo).plan(second.id)] == ["atlas"]
    third = repo.append_message(
        channel.id,
        "agent",
        "review again",
        author_profile_id="atlas",
        intent_envelope=_intent("review_request", ["critic"]),
    )
    _link_turn(repo, second.id, third.id, "atlas")
    router = Router(repo)

    assert router.plan(third.id) == []
    assert router.decisions_for(third.id)[-1].disposition == "loop_blocked"


def test_question_schedules_its_named_recipient(tmp_path):
    """The collaboration skill promises that asking someone by name wakes
    them; `question` must be a scheduling intent (regression: it was not,
    so agent questions silently got no answer)."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "critic")
    message = repo.append_message(
        channel.id,
        "agent",
        "Which port does the dashboard use?",
        author_profile_id="atlas",
        intent_envelope=_intent("question", ["critic"]),
    )

    turns = Router(repo).plan(message.id)

    assert [(turn.profile_id, turn.trigger) for turn in turns] == [
        ("critic", "intent:question")
    ]


def test_agent_text_mentions_route_when_envelope_names_nobody(tmp_path):
    """Models write "@freya please…" in prose with an empty envelope; text
    mentions must route (with all loop caps still applying), while terminal
    intents stay silent even with mentions."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "freya")
    repo.add_member(channel.id, "thoth")
    repo.update_member_presentation("thoth", display_name="Thoth Prime")
    message = repo.append_message(
        channel.id,
        "agent",
        "@freya please analyze edge cases. @ThothPrime draft the docs.",
        author_profile_id="athena",
        intent_envelope=_intent("inform"),
    )

    turns = Router(repo).plan(message.id)
    assert sorted((turn.profile_id, turn.trigger) for turn in turns) == [
        ("freya", "agent_mention"),
        ("thoth", "agent_mention"),
    ]

    result_message = repo.append_message(
        channel.id,
        "agent",
        "Done. Thanks @freya!",
        author_profile_id="athena",
        intent_envelope=_intent("result"),
    )
    assert Router(repo).plan(result_message.id) == []


def test_result_with_named_recipient_wakes_the_collector(tmp_path):
    """Delegates finishing with `result` addressed to the delegator wake her
    once to consolidate; recipient-less results stay terminal."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "athena")
    delivered = repo.append_message(
        channel.id,
        "agent",
        "Docs blurb attached.",
        author_profile_id="thoth",
        intent_envelope={
            "schemaVersion": 1,
            "intent": "result",
            "recipients": ["athena"],
            "replyExpected": False,
            "replyBudget": 0,
            "correlationId": None,
            "summary": "",
        },
    )
    turns = Router(repo).plan(delivered.id)
    assert [(turn.profile_id, turn.trigger) for turn in turns] == [
        ("athena", "intent:result")
    ]

    fire_and_forget = repo.append_message(
        channel.id,
        "agent",
        "Done. Thanks everyone!",
        author_profile_id="freya",
        intent_envelope=_intent("result"),
    )
    assert Router(repo).plan(fire_and_forget.id) == []


def test_workspace_routing_defaults_apply_and_channel_overrides_win(tmp_path):
    """Budget layering: built-ins < workspace defaults < channel overrides."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    repo.set_setting("routing_defaults", {"max_automated_turns": 0})
    plain = repo.create_channel("plain")
    repo.add_member(plain.id, "freya")
    message = repo.append_message(
        plain.id,
        "agent",
        "@freya go",
        author_profile_id="athena",
        intent_envelope=_intent("handoff", ["freya"]),
    )
    # Workspace default of 0 automated turns blocks everything.
    assert Router(repo).plan(message.id) == []

    boosted = repo.create_channel("boosted", routing_rules={"max_automated_turns": 6})
    repo.add_member(boosted.id, "freya")
    message2 = repo.append_message(
        boosted.id,
        "agent",
        "@freya go",
        author_profile_id="athena",
        intent_envelope=_intent("handoff", ["freya"]),
    )
    # The channel override wins over the workspace default.
    assert [turn.profile_id for turn in Router(repo).plan(message2.id)] == ["freya"]
