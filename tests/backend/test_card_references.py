import json
from types import SimpleNamespace

import pytest

from hermes_channels_backend.card_references import (
    CardReferenceStore,
    _shared_database_path,
    annotate_kanban_tool_result,
    generate_prefix,
    translate_kanban_tool_args,
)
from hermes_channels_backend.db import CrewDatabase


def _task(task_id, created_at):
    return SimpleNamespace(id=task_id, created_at=created_at)


def test_profile_hooks_use_the_owner_channels_database(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    profile = root / "profiles" / "atlas"
    profile.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile))

    assert _shared_database_path() == root / "channels" / "channels.db"


def test_every_board_gets_a_generated_default_prefix():
    assert generate_prefix("channel-seatech") == "SE"
    assert generate_prefix("channel-the-others") == "TO"
    assert generate_prefix("channel-new-venture") == "NV"
    assert generate_prefix("personal") == "PE"


def test_user_override_controls_new_references_and_persists(tmp_path):
    database = CrewDatabase(tmp_path / "channels.db")
    store = CardReferenceStore(database)

    configured = store.configure_prefix("channel-seatech", "sd")
    references = CardReferenceStore(database).ensure_references(
        "channel-seatech", [_task("t_first", 10)]
    )

    assert configured == {
        "boardSlug": "channel-seatech",
        "prefix": "SD",
        "generatedPrefix": "SE",
        "customized": True,
        "migratedCards": 0,
    }
    assert references == {"t_first": "SD-1"}


def test_editing_prefix_migrates_existing_references_and_keeps_sequence(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    tasks = [_task("t_first", 10), _task("t_second", 20)]
    assert store.ensure_references("channel-seatech", tasks) == {
        "t_first": "SE-1",
        "t_second": "SE-2",
    }

    changed = store.configure_prefix("channel-seatech", "SD")

    assert changed["migratedCards"] == 2
    assert store.ensure_references("channel-seatech", tasks) == {
        "t_first": "SD-1",
        "t_second": "SD-2",
    }
    assert store.resolve("channel-seatech", "SD-1") == "t_first"
    assert store.resolve("channel-seatech", "SE-1") is None


def test_reset_returns_to_generated_prefix_and_migrates_cards(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    store.configure_prefix("channel-circle", "CR")
    store.ensure_references("channel-circle", [_task("t_hidden", 1)])

    reset = store.configure_prefix("channel-circle", None)

    assert reset == {
        "boardSlug": "channel-circle",
        "prefix": "CI",
        "generatedPrefix": "CI",
        "customized": False,
        "migratedCards": 1,
    }
    assert store.reference_for("channel-circle", "t_hidden") == "CI-1"


def test_migration_to_a_used_prefix_resequences_without_unique_collisions(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    store.configure_prefix("board-a", "SD")
    store.ensure_references("board-a", [_task("t_a", 1)])
    store.ensure_references(
        "board-b", [_task("t_b1", 1), _task("t_b2", 2)]
    )

    changed = store.configure_prefix("board-b", "SD")

    assert changed["migratedCards"] == 2
    assert store.reference_for("board-b", "t_b1") == "SD-2"
    assert store.reference_for("board-b", "t_b2") == "SD-3"


def test_invalid_prefix_is_rejected(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))

    for invalid in ("", "9X", "TOO-LONG", "åä", "ABCDEFGHI"):
        with pytest.raises(ValueError, match="prefix"):
            store.configure_prefix("channel-seatech", invalid)


def test_references_are_stable_sequential_and_never_reused(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    store.configure_prefix("channel-seatech", "SD")

    first = store.ensure_references(
        "channel-seatech",
        [_task("t_second", 20), _task("t_first", 10)],
    )
    assert first == {"t_first": "SD-1", "t_second": "SD-2"}

    second = store.ensure_references(
        "channel-seatech",
        [_task("t_third", 30), _task("t_second", 20)],
    )
    assert second == {"t_second": "SD-2", "t_third": "SD-3"}

    third = store.ensure_references(
        "channel-seatech", [_task("t_fourth", 40)]
    )
    assert third == {"t_fourth": "SD-4"}


def test_two_boards_can_share_one_custom_prefix_sequence(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    store.configure_prefix("channel-cultdrops-planning", "CD")
    store.configure_prefix("channel-cultdrops-build", "CD")

    planning = store.ensure_references(
        "channel-cultdrops-planning", [_task("t_plan", 1)]
    )
    build = store.ensure_references(
        "channel-cultdrops-build", [_task("t_build", 2)]
    )

    assert planning == {"t_plan": "CD-1"}
    assert build == {"t_build": "CD-2"}


def test_kanban_tool_results_expose_references_without_replacing_internal_ids(tmp_path):
    database_path = tmp_path / "channels.db"
    CardReferenceStore(CrewDatabase(database_path)).configure_prefix(
        "channel-seatech", "SD"
    )
    result = json.dumps(
        {
            "tasks": [
                {"id": "t_alpha", "title": "First", "created_at": 10},
                {"id": "t_beta", "title": "Second", "created_at": 20},
            ]
        }
    )

    transformed = annotate_kanban_tool_result(
        tool_name="kanban_list",
        args={"board": "channel-seatech"},
        result=result,
        database_path=database_path,
    )
    payload = json.loads(transformed)

    assert [(task["reference"], task["id"]) for task in payload["tasks"]] == [
        ("SD-1", "t_alpha"),
        ("SD-2", "t_beta"),
    ]
    assert annotate_kanban_tool_result(
        tool_name="terminal",
        args={},
        result="unchanged",
        database_path=database_path,
    ) is None


def test_pre_tool_hook_translates_human_reference_to_internal_id(tmp_path):
    database_path = tmp_path / "channels.db"
    store = CardReferenceStore(CrewDatabase(database_path))
    store.configure_prefix("channel-seatech", "SD")
    store.ensure_references("channel-seatech", [_task("t_hidden", 1)])

    directive = translate_kanban_tool_args(
        tool_name="kanban_show",
        args={"board": "channel-seatech", "task_id": "SD-1"},
        database_path=database_path,
    )

    assert directive == {"action": "modify", "args": {"task_id": "t_hidden"}}
    assert translate_kanban_tool_args(
        tool_name="kanban_show",
        args={"board": "channel-seatech", "task_id": "t_hidden"},
        database_path=database_path,
    ) is None
