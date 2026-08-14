from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.models import ProjectRef
from hermes_channels_backend.repositories import CrewRepository


def test_duplicate_message_command_returns_the_original_row(tmp_path):
    """A retried client command must not append a second message."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general")

    first = repo.append_message(
        channel.id,
        "user",
        "hello",
        idempotency_key="composer-command-1",
        mentions=["atlas"],
    )
    duplicate = repo.append_message(
        channel.id,
        "user",
        "this payload is ignored",
        idempotency_key="composer-command-1",
        mentions=["scout"],
    )

    assert duplicate == first
    assert repo.list_messages(channel.id) == [first]


def test_thread_query_does_not_leak_other_channel_messages(tmp_path):
    """Opening a thread must return only its root and descendants."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general")
    root = repo.append_message(channel.id, "user", "root")
    reply = repo.append_message(
        channel.id, "agent", "reply", root_message_id=root.id, author_profile_id="atlas"
    )
    repo.append_message(channel.id, "user", "unrelated")

    assert repo.get_thread(root.id) == [root, reply]


def test_member_default_project_is_persisted_per_profile(tmp_path):
    """Adding another profile must not overwrite an existing member default."""
    repo = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    channel = repo.create_channel("general")
    atlas_project = ProjectRef(
        mode="project",
        profile="atlas",
        project_id="web",
        label="Web",
        cwd="/work/web",
    )

    repo.add_member(channel.id, "atlas", default_project=atlas_project)
    repo.add_member(channel.id, "scout")

    assert repo.member_default_project("atlas") == atlas_project
    assert repo.member_default_project("scout") is None
