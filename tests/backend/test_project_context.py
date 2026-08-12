from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.models import ProjectRef
from hermes_crew_backend.project_context import (
    project_key,
    resolve_project_context,
    resolve_scope_id,
)
from hermes_crew_backend.repositories import CrewRepository


PROJECT_WEB = ProjectRef(
    mode="project",
    profile="atlas",
    project_id="p_web",
    label="Web",
    cwd="/work/web",
)


def test_message_project_becomes_thread_project_without_mutating_channel(tmp_path):
    """An ad-hoc project must stay on its root while later mainline work is global."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel(
        "general", default_project=ProjectRef(mode="global")
    )
    root = repo.append_message(channel.id, "user", "fix login", project=PROJECT_WEB)
    reply = repo.append_message(
        channel.id, "agent", "working", root_message_id=root.id, author_profile_id="atlas"
    )
    other = repo.append_message(channel.id, "user", "summarize today")

    assert resolve_project_context(repo, channel.id, root.id).project_id == "p_web"
    assert resolve_project_context(repo, channel.id, reply.id).project_id == "p_web"
    assert resolve_scope_id(repo, channel.id, root.id) == root.id
    assert resolve_scope_id(repo, channel.id, reply.id) == root.id
    assert resolve_project_context(repo, channel.id, other.id).mode == "global"
    assert repo.require_channel(channel.id).default_project.mode == "global"


def test_explicit_global_overrides_channel_project(tmp_path):
    """The user must be able to opt one message out of a project channel."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("web", default_project=PROJECT_WEB)
    message = repo.append_message(
        channel.id,
        "user",
        "general question",
        project=ProjectRef(mode="global"),
    )

    assert resolve_project_context(repo, channel.id, message.id).mode == "global"
    assert resolve_scope_id(repo, channel.id, message.id) == message.id


def test_target_member_default_is_used_after_inherited_channel_context(tmp_path):
    """An unassigned channel may fall back to the selected agent's own project."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "atlas", default_project=PROJECT_WEB)
    message = repo.append_message(
        channel.id, "user", "inspect app", target_profile="atlas"
    )

    assert resolve_project_context(repo, channel.id, message.id) == PROJECT_WEB


def test_project_key_normalizes_equivalent_working_directories():
    """Equivalent cwd spellings must reuse the same Hermes session binding."""
    with_parent_segment = PROJECT_WEB.model_copy(update={"cwd": "/work/tmp/../web"})

    assert project_key(with_parent_segment) == "atlas:p_web:/work/web"
    assert project_key(ProjectRef(mode="global")) == "global"
