import pytest

from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.models import ProjectRef
from hermes_channels_backend.project_context import resolve_project_context
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.scheduler import Scheduler

from tests.integration.fake_hermes import (
    FakeHermesGateway,
    FakeProfile,
    ReadinessError,
    marker,
)


pytestmark = pytest.mark.acceptance


ATLAS = FakeProfile("openai", "gpt-5.6")
SCOUT = FakeProfile("google", "gemini-2.5-pro")
CRITIC = FakeProfile("anthropic", "claude-sonnet-4.5")
WEB = ProjectRef(
    mode="project",
    profile="atlas",
    project_id="p-web",
    label="Web",
    cwd="/work/web",
)
HERMES = ProjectRef(
    mode="project",
    profile="atlas",
    project_id="p-hermes",
    label="Hermes",
    cwd="/work/hermes",
)


def _crew(tmp_path, *, channel_project: ProjectRef | None = None):
    repository = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repository.create_channel(
        "general",
        default_responder_profile="atlas",
        default_project=channel_project or ProjectRef(mode="global"),
    )
    repository.add_member(channel.id, "atlas", activation_policy="always")
    repository.add_member(channel.id, "scout", activation_policy="mentioned")
    repository.add_member(channel.id, "critic", activation_policy="mentioned")
    scheduler = Scheduler(repository)
    gateway = FakeHermesGateway(
        repository,
        scheduler,
        profiles={"atlas": ATLAS, "scout": SCOUT, "critic": CRITIC},
        projects={("atlas", "/work/web"), ("atlas", "/work/hermes")},
    )
    return repository, channel, scheduler, gateway


def _states(repository: CrewRepository) -> list[tuple[str | None, str]]:
    with repository.database.connect() as connection:
        rows = connection.execute(
            "SELECT profile_id, state FROM turns ORDER BY created_at, id"
        ).fetchall()
    return [(row["profile_id"], row["state"]) for row in rows]


def test_default_atlas_and_always_scout_use_independent_models(tmp_path):
    repository, channel, _, gateway = _crew(tmp_path)
    repository.add_member(channel.id, "scout", activation_policy="always")
    _, turns = gateway.submit_user(channel.id, "Compare approaches")

    sessions = [gateway.start_next(), gateway.start_next()]

    assert {turn.profile_id for turn in turns} == {"atlas", "scout"}
    assert {
        (session.profile_id, session.provider, session.model)
        for session in sessions
        if session is not None
    } == {
        ("atlas", "openai", "gpt-5.6"),
        ("scout", "google", "gemini-2.5-pro"),
    }


def test_inform_result_creates_zero_child_turns(tmp_path):
    repository, channel, _, gateway = _crew(tmp_path)
    gateway.submit_user(channel.id, "Summarize the status")
    session = gateway.start_next()
    assert session is not None

    gateway.complete(session.turn_id, f"All done.\n{marker('inform')}")

    assert _states(repository) == [("atlas", "completed")]
    assert gateway.start_next() is None


def test_atlas_can_request_exactly_one_critic_review(tmp_path):
    repository, channel, _, gateway = _crew(tmp_path)
    gateway.submit_user(channel.id, "Implement this")
    atlas = gateway.start_next()
    assert atlas is not None
    gateway.complete(
        atlas.turn_id,
        f"Ready for review.\n{marker('review_request', recipients=['critic'], reply_expected=True, reply_budget=1)}",
    )

    critic = gateway.start_next()

    assert critic is not None and critic.profile_id == "critic"
    gateway.complete(critic.turn_id, f"Looks good.\n{marker('result')}")
    assert _states(repository) == [("atlas", "completed"), ("critic", "completed")]


def test_critic_to_atlas_chain_is_blocked_at_loop_boundary(tmp_path):
    repository, channel, scheduler, gateway = _crew(tmp_path)
    gateway.submit_user(channel.id, "Implement and review")
    atlas_one = gateway.start_next()
    assert atlas_one is not None
    gateway.complete(
        atlas_one.turn_id,
        f"Review.\n{marker('review_request', recipients=['critic'], reply_expected=True, reply_budget=1)}",
    )
    critic = gateway.start_next()
    assert critic is not None
    gateway.complete(
        critic.turn_id,
        f"Revise.\n{marker('handoff', recipients=['atlas'], reply_expected=True, reply_budget=1)}",
    )
    atlas_two = gateway.start_next()
    assert atlas_two is not None
    completed = gateway.complete(
        atlas_two.turn_id,
        f"Review again.\n{marker('review_request', recipients=['critic'], reply_expected=True, reply_budget=1)}",
    )

    result = repository.require_message(completed.result_message_id)
    assert scheduler.router.decisions_for(result.id)[-1].disposition == "loop_blocked"
    assert gateway.start_next() is None


def test_dedicated_project_channel_dispatches_from_hermes_worktree(tmp_path):
    _, channel, _, gateway = _crew(tmp_path, channel_project=HERMES)
    gateway.submit_user(channel.id, "Run the Hermes tests")

    session = gateway.start_next()

    assert session is not None and session.cwd == "/work/hermes"
    assert gateway.calls[0][1]["cwd"] == "/work/hermes"


def test_message_project_stays_with_thread_and_next_top_level_is_global(tmp_path):
    repository, channel, _, gateway = _crew(tmp_path)
    root, _ = gateway.submit_user(channel.id, "Fix the web app", project=WEB)
    first = gateway.start_next()
    assert first is not None and first.cwd == "/work/web"
    gateway.complete(first.turn_id, f"Initial result.\n{marker('result')}")
    reply, _ = gateway.submit_user(
        channel.id,
        "Also update the tests",
        root_message_id=root.id,
    )
    threaded = gateway.start_next()
    assert threaded is not None and threaded.cwd == "/work/web"

    next_message, _ = gateway.submit_user(channel.id, "What else is pending?")

    assert resolve_project_context(repository, channel.id, reply.id).cwd == "/work/web"
    assert resolve_project_context(repository, channel.id, next_message.id).mode == "global"


def test_stopping_atlas_does_not_prevent_scout_from_completing(tmp_path):
    repository, channel, scheduler, gateway = _crew(tmp_path)
    repository.add_member(channel.id, "scout", activation_policy="always")
    gateway.submit_user(channel.id, "Investigate in parallel")
    first = gateway.start_next()
    second = gateway.start_next()
    assert first is not None and second is not None
    by_profile = {first.profile_id: first, second.profile_id: second}

    scheduler.cancel(by_profile["atlas"].turn_id)
    gateway.complete(by_profile["scout"].turn_id, f"Found it.\n{marker('result')}")

    assert sorted(_states(repository)) == [("atlas", "cancelled"), ("scout", "completed")]


def test_rejected_approval_resumes_same_turn_without_a_child(tmp_path):
    repository, channel, scheduler, gateway = _crew(tmp_path)
    gateway.submit_user(channel.id, "Try a guarded command")
    session = gateway.start_next()
    assert session is not None
    approval = gateway.request_approval(session.turn_id, "approval-1")

    resolved = gateway.resolve_approval(approval.id, "reject")

    assert resolved.decision == "reject"
    assert scheduler.get(session.turn_id).state == "running"
    assert _states(repository) == [("atlas", "running")]


def test_restart_interrupts_running_work_without_duplicate_submit(tmp_path):
    repository, channel, scheduler, gateway = _crew(tmp_path)
    gateway.submit_user(
        channel.id,
        "Run once",
        idempotency_key="restart-once",
    )
    session = gateway.start_next()
    assert session is not None

    # stale_after_ms=0: single-host crash-restart semantics (the default
    # keeps fresh turns alive because the sibling host may be driving them).
    interrupted = scheduler.reconcile_startup(set(), stale_after_ms=0)
    gateway.submit_user(
        channel.id,
        "Run once",
        idempotency_key="restart-once",
    )

    assert interrupted == [session.turn_id]
    assert scheduler.get(session.turn_id).state == "interrupted"
    assert gateway.submitted_turn_ids.count(session.turn_id) == 1
    assert gateway.start_next() is None
    assert _states(repository) == [("atlas", "interrupted")]


@pytest.mark.parametrize(
    ("profile", "project", "expected"),
    [
        (None, None, "profile ghost does not exist"),
        (FakeProfile("openai", None), None, "profile atlas has no configured model"),
        (ATLAS, ProjectRef(mode="project", profile="atlas", projectId="missing", cwd="/work/missing"), "project /work/missing is not available to profile atlas"),
    ],
)
def test_missing_profile_model_and_project_are_durable_readiness_errors(
    tmp_path, profile, project, expected
):
    repository = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    target = "ghost" if profile is None else "atlas"
    channel = repository.create_channel("general", default_responder_profile=target)
    repository.add_member(channel.id, target, activation_policy="always")
    scheduler = Scheduler(repository)
    gateway = FakeHermesGateway(
        repository,
        scheduler,
        profiles={} if profile is None else {"atlas": profile},
        projects=set(),
    )
    gateway.submit_user(channel.id, "Run it", project=project)

    with pytest.raises(ReadinessError, match=expected):
        gateway.start_next()

    assert _states(repository) == [(target, "failed")]
    failed = scheduler.events_after(0)[-1]
    assert failed.type == "failed"
    assert failed.payload == {"error": expected}


def test_placement_controls_where_answers_land(tmp_path):
    repository, channel, _, gateway = _crew(tmp_path)

    gateway.submit_user(channel.id, "Give me a status summary")
    auto_turn = gateway.start_next()
    assert auto_turn is not None
    auto = gateway.complete(auto_turn.turn_id, f"Summary ready.\n{marker('result')}")
    auto_result = repository.require_message(auto.result_message_id)
    assert auto_result.root_message_id is None

    gateway.submit_user(channel.id, "Log your progress in a thread")
    thread_turn = gateway.start_next()
    assert thread_turn is not None
    threaded = gateway.complete(
        thread_turn.turn_id,
        f"Working log entry.\n{marker('inform', placement='thread')}",
    )
    threaded_result = repository.require_message(threaded.result_message_id)
    assert threaded_result.root_message_id is not None

    thread_root = threaded_result.root_message_id
    root_message = repository.require_message(thread_root)
    assert root_message.author_type == "user"

    user_thread_reply = gateway.submit_user(
        channel.id,
        "Now post the final answer to the channel",
        root_message_id=thread_root,
        mentions=["atlas"],
    )
    channel_turn = gateway.start_next()
    assert channel_turn is not None
    promoted = gateway.complete(
        channel_turn.turn_id,
        f"Final answer for everyone.\n{marker('result', placement='channel')}",
    )
    promoted_result = repository.require_message(promoted.result_message_id)
    assert promoted_result.root_message_id is None
    assert user_thread_reply is not None


def test_relay_inherits_message_scoped_project_across_channel_level_answers(tmp_path):
    """A handoff keeps the trigger's one-message project even though the
    answer now lands at channel level instead of inside a synthetic thread."""
    repository, channel, _, gateway = _crew(tmp_path)
    gateway.submit_user(channel.id, "Fix the web app", project=WEB, mentions=["atlas"])
    atlas = gateway.start_next()
    assert atlas is not None and atlas.cwd == "/work/web"
    gateway.complete(
        atlas.turn_id,
        f"Scout, verify please.\n{marker('handoff', recipients=['scout'], reply_expected=True, reply_budget=1)}",
    )

    with repository.database.connect() as connection:
        row = connection.execute(
            "SELECT cwd FROM turns WHERE profile_id = 'scout'"
        ).fetchone()
    assert row is not None and row["cwd"] == "/work/web"


def test_relay_chain_reuses_one_session_scope_per_origin(tmp_path):
    """Two independent channel-level requests must not share agent sessions,
    while one relay chain keeps reusing its own session binding."""
    repository, channel, _, gateway = _crew(tmp_path)

    first_root, _ = gateway.submit_user(channel.id, "Task one", mentions=["atlas"])
    atlas_one = gateway.start_next()
    gateway.complete(
        atlas_one.turn_id,
        f"Scout please.\n{marker('handoff', recipients=['scout'], reply_expected=True, reply_budget=1)}",
    )
    scout_one = gateway.start_next()
    assert scout_one is not None

    second_root, _ = gateway.submit_user(channel.id, "Task two", mentions=["atlas"])
    atlas_two = gateway.start_next()
    gateway.complete(
        atlas_two.turn_id,
        f"Scout again.\n{marker('handoff', recipients=['scout'], reply_expected=True, reply_budget=1)}",
    )
    scout_two = gateway.start_next()
    assert scout_two is not None

    with repository.database.connect() as connection:
        scopes = [
            row["scope_id"]
            for row in connection.execute(
                "SELECT scope_id FROM session_bindings WHERE profile_id = 'scout' ORDER BY rowid"
            ).fetchall()
        ]
    assert scopes == [first_root.id, second_root.id]


def test_fan_out_shares_one_automation_budget(tmp_path):
    """Recipients of one fan-out consume a single automated-turn budget: the
    causal tree, not each branch, is bounded by max_automated_turns."""
    repository, channel, scheduler, gateway = _crew(tmp_path)
    with repository.database.connect() as connection:
        connection.execute(
            "UPDATE channels SET routing_rules_json = ? WHERE id = ?",
            ('{"max_automated_turns": 2, "max_depth": 10}', channel.id),
        )

    gateway.submit_user(channel.id, "Coordinate this", mentions=["atlas"])
    atlas = gateway.start_next()
    assert atlas is not None
    completed = gateway.complete(
        atlas.turn_id,
        f"Team, split up.\n{marker('handoff', recipients=['scout', 'critic'], reply_expected=True, reply_budget=2)}",
    )

    result = repository.require_message(completed.result_message_id)
    decisions = scheduler.router.decisions_for(result.id)
    dispositions = sorted(decision.disposition for decision in decisions)
    assert dispositions == ["budget_blocked", "scheduled"]
