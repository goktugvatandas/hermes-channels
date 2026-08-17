from types import SimpleNamespace

from hermes_channels_backend.card_references import (
    BOARD_PREFIXES,
    CardReferenceStore,
    annotate_kanban_tool_result,
    prefix_for_board,
    translate_kanban_tool_args,
)
from hermes_channels_backend.db import CrewDatabase


def _task(task_id, created_at):
    return SimpleNamespace(id=task_id, created_at=created_at)


def test_agreed_work_area_prefixes_are_canonical():
    assert BOARD_PREFIXES == {
        "channel-seatech": "SD",
        "channel-the-others": "TO",
        "channel-circle": "CR",
        "channel-kronomyth": "KM",
        "channel-oss": "OS",
        "channel-hq": "HQ",
        "channel-cultdrops": "CD",
    }
    assert prefix_for_board("channel-seatech") == "SD"
    assert prefix_for_board("channel-cultdrops-build") == "CD"
    assert prefix_for_board("channel-new-venture") == "NV"


def test_references_are_stable_sequential_and_never_reused(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))

    first = store.ensure_references(
        "channel-seatech",
        [_task("t_second", 20), _task("t_first", 10)],
    )
    assert first == {"t_first": "SD-1", "t_second": "SD-2"}

    # Input order changes and one card disappears; surviving aliases stay fixed.
    second = store.ensure_references(
        "channel-seatech",
        [_task("t_third", 30), _task("t_second", 20)],
    )
    assert second == {"t_second": "SD-2", "t_third": "SD-3"}

    # A deleted card's number is never recycled.
    third = store.ensure_references(
        "channel-seatech",
        [_task("t_fourth", 40)],
    )
    assert third == {"t_fourth": "SD-4"}


def test_related_boards_share_one_area_sequence(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))

    planning = store.ensure_references(
        "channel-cultdrops-planning", [_task("t_plan", 1)]
    )
    build = store.ensure_references(
        "channel-cultdrops-build", [_task("t_build", 2)]
    )

    assert planning == {"t_plan": "CD-1"}
    assert build == {"t_build": "CD-2"}


def test_reference_resolution_accepts_human_alias_or_internal_id(tmp_path):
    store = CardReferenceStore(CrewDatabase(tmp_path / "channels.db"))
    store.ensure_references("channel-circle", [_task("t_hidden", 1)])

    assert store.resolve("channel-circle", "CR-1") == "t_hidden"
    assert store.resolve("channel-circle", "cr-1") == "t_hidden"
    assert store.resolve("channel-circle", "t_hidden") == "t_hidden"
    assert store.resolve("channel-circle", "SD-1") is None


def test_kanban_tool_results_expose_references_without_replacing_internal_ids(tmp_path):
    import json

    database_path = tmp_path / "channels.db"
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
