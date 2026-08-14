from hermes_channels_backend.context_builder import ContextBuilder, RESPONSE_CONTRACT
from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.models import ProjectRef
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.routing import Router


def _review_intent() -> dict:
    return {
        "schemaVersion": 1,
        "intent": "review_request",
        "recipients": ["critic"],
        "replyExpected": True,
        "replyBudget": 1,
        "correlationId": "review-1",
        "summary": "Review the implementation",
    }


def test_agent_context_contains_resolved_scope_and_omits_other_threads(tmp_path):
    """A turn must see its own project/thread, never a sibling thread's content."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    project = ProjectRef(
        mode="project",
        profile="atlas",
        project_id="p_web",
        label="Web",
        cwd="/work/web",
    )
    channel = repo.create_channel(
        "development", purpose="Build the product", default_project=project
    )
    repo.add_member(channel.id, "atlas", activation_policy="mentioned")
    repo.add_member(channel.id, "critic", activation_policy="mentioned")
    unrelated = repo.append_message(channel.id, "user", "unrelated root")
    repo.append_message(
        channel.id,
        "agent",
        "UNRELATED_THREAD_SECRET",
        root_message_id=unrelated.id,
        author_profile_id="scout",
    )
    root = repo.append_message(channel.id, "user", "Implement login")
    review = repo.append_message(
        channel.id,
        "agent",
        "Please review the login work",
        root_message_id=root.id,
        author_profile_id="atlas",
        intent_envelope=_review_intent(),
    )
    turn = Router(repo).plan(review.id)[0]

    context = ContextBuilder(repo).for_turn(turn)

    for heading in (
        "CHANNEL",
        "PARTICIPANTS",
        "PROJECT",
        "TRIGGER",
        "THREAD",
        "RECENT CHANNEL",
        "BUDGET",
        "RESPONSE CONTRACT",
    ):
        assert f"## {heading}" in context
    assert "Build the product" in context
    assert "atlas (mentioned)" in context
    assert "critic (mentioned)" in context
    assert "project_id: p_web" in context
    assert "cwd: /work/web" in context
    assert "Implement login" in context
    assert "Please review the login work" in context
    assert "incoming_intent: review_request" in context
    assert "remaining_depth: 1" in context
    assert "UNRELATED_THREAD_SECRET" not in context
    assert context.endswith(RESPONSE_CONTRACT)


def test_agent_context_caps_each_message_and_total_size(tmp_path):
    """One pathological message must not overrun the model context budget."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    long_tail = "END_OF_OVERSIZED_MESSAGE"
    message = repo.append_message(channel.id, "user", ("x" * 130_000) + long_tail)
    turn = Router(repo).plan(message.id)[0]

    context = ContextBuilder(repo).for_turn(turn)

    assert len(context) <= 120_000
    assert long_tail not in context
    assert context.endswith(RESPONSE_CONTRACT)


def test_classifier_context_is_json_only_and_lists_exact_members(tmp_path):
    """The classifier must be constrained to enabled channel profile ids."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general", purpose="Route requests")
    repo.add_member(channel.id, "atlas")
    repo.add_member(channel.id, "scout", activation_policy="observer")
    repo.add_member(channel.id, "disabled", activation_policy="disabled")
    message = repo.append_message(channel.id, "user", "Research this")

    instructions, input_text = ContextBuilder(repo).for_classifier(message)

    assert "JSON only" in instructions
    assert "atlas, scout" in instructions
    assert "disabled" not in instructions
    for intent in (
        "inform",
        "result",
        "reply_required",
        "question",
        "handoff",
        "review_request",
        "blocked",
        "approval_request",
    ):
        assert intent in instructions
    assert '{"intent":"inform","recipients":[],"confidence":0}' in instructions
    assert "Route requests" in input_text
    assert "Research this" in input_text
