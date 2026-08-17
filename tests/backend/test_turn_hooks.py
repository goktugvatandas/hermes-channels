import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.models import IntentEnvelope
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.routing import Router
from hermes_channels_backend.scheduler import Scheduler
from hermes_channels_backend.turn_hooks import (
    on_channel_session_end,
    on_channel_stream_boundary,
    persist_channel_response,
)


def _plugin_register():
    plugin_dir = Path(__file__).resolve().parents[2] / "plugin"
    spec = importlib.util.spec_from_file_location(
        "hermes_channels_plugin_under_test",
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.register


def _running_turn(tmp_path, *, stored_session_id="stored-1"):
    database_path = tmp_path / "channels.db"
    repo = CrewRepository(CrewDatabase(database_path))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "build it")
    scheduler = Scheduler(repo)
    turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-a")
    scheduler.bind_session(
        turn.id,
        runtime_session_id="runtime-1",
        stored_session_id=stored_session_id,
    )
    return database_path, repo, scheduler, turn


def _response(text="Done"):
    return (
        f"{text}\n\n"
        '[[hermes-channels:intent {"schemaVersion":1,"intent":"result",'
        '"recipients":[],"replyExpected":false,"replyBudget":0,'
        '"correlationId":null,"summary":"done","placement":"auto"}]]'
    )


def test_post_llm_hook_completes_turn_without_desktop_completion_event(tmp_path):
    database_path, repo, scheduler, turn = _running_turn(tmp_path)

    assert persist_channel_response(
        session_id="stored-1",
        assistant_response=_response("Durably done"),
        database_path=database_path,
    )

    completed = scheduler.get(turn.id)
    assert completed.state == "completed"
    result = repo.require_message(completed.result_message_id)
    assert result.content == "Durably done"
    assert result.parent_message_id == turn.trigger_message_id
    completed_event = [
        frame
        for frame in scheduler.events_after(0, channel_id=turn.channel_id)
        if frame.type == "completed"
    ][-1]
    assert completed_event.payload["source"] == "post_llm_call"


def test_post_llm_hook_joins_multi_message_prose_and_intent_marker(tmp_path):
    database_path, repo, scheduler, turn = _running_turn(tmp_path)
    marker = _response("").strip()
    history = [
        {"role": "user", "content": "do the work"},
        {"role": "assistant", "content": "First part of the answer"},
        {"role": "tool", "content": "tool result"},
        {"role": "assistant", "content": marker},
    ]

    assert persist_channel_response(
        session_id="stored-1",
        assistant_response=marker,
        conversation_history=history,
        database_path=database_path,
    )

    result = repo.require_message(scheduler.get(turn.id).result_message_id)
    assert result.content == "First part of the answer"


def test_post_llm_hook_prefers_an_active_binding_over_completed_history(tmp_path):
    database_path, repo, scheduler, old_turn = _running_turn(tmp_path)
    assert persist_channel_response(
        session_id="stored-1",
        assistant_response=_response("Old answer"),
        database_path=database_path,
    )

    channel_id = old_turn.channel_id
    message = repo.append_message(channel_id, "user", "second request")
    active_turn = scheduler.enqueue(Router(repo).plan(message.id)[0])
    scheduler.claim("desktop-b")
    scheduler.bind_session(
        active_turn.id,
        runtime_session_id="runtime-2",
        stored_session_id="stored-1",
    )
    # Clock skew/imported history can make the completed row look newer. State
    # authority must win over timestamps when a session id is reused.
    with repo.database.connect() as connection:
        connection.execute(
            "update turns set created_at = created_at + 100000 where id = ?",
            (old_turn.id,),
        )

    assert persist_channel_response(
        session_id="stored-1",
        assistant_response=_response("New answer"),
        database_path=database_path,
    )

    completed = scheduler.get(active_turn.id)
    assert completed.state == "completed"
    assert repo.require_message(completed.result_message_id).content == "New answer"


def test_renderer_completion_after_hook_is_idempotent(tmp_path):
    database_path, repo, scheduler, turn = _running_turn(tmp_path)
    assert persist_channel_response(
        session_id="stored-1",
        assistant_response=_response(),
        database_path=database_path,
    )

    first = scheduler.get(turn.id)
    repeated = scheduler.complete(
        turn.id,
        visible_text="Done",
        envelope=IntentEnvelope(intent="result"),
    )

    assert repeated.result_message_id == first.result_message_id
    with repo.database.connect() as connection:
        count = connection.execute(
            "select count(*) from messages where idempotency_key = ?",
            (f"result:{turn.id}",),
        ).fetchone()[0]
    assert count == 1


def test_session_end_recovers_persisted_final_response(tmp_path):
    database_path, repo, scheduler, turn = _running_turn(tmp_path)
    profile_home = tmp_path / "profile"
    profile_home.mkdir()
    state_db = profile_home / "state.db"
    with sqlite3.connect(state_db) as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.execute(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, 'assistant', ?, 'stop', ?)",
            (
                "stored-1",
                _response("Recovered at session end"),
                turn.created_at / 1000 + 1,
            ),
        )

    assert on_channel_session_end(
        session_id="stored-1",
        completed=True,
        interrupted=False,
        database_path=database_path,
        profile_home=profile_home,
    )

    completed_turn = scheduler.get(turn.id)
    assert completed_turn.state == "completed"
    assert repo.require_message(completed_turn.result_message_id).content == "Recovered at session end"


def test_session_end_never_replays_a_previous_turn_from_the_same_session(tmp_path):
    database_path, _, scheduler, turn = _running_turn(tmp_path)
    profile_home = tmp_path / "profile"
    profile_home.mkdir()
    with sqlite3.connect(profile_home / "state.db") as connection:
        connection.execute(
            "create table messages (id integer primary key, session_id text, role text, "
            "content text, finish_reason text, timestamp real)"
        )
        connection.execute(
            "insert into messages(session_id, role, content, finish_reason, timestamp) "
            "values (?, 'assistant', 'Prior response', 'stop', ?)",
            ("stored-1", turn.created_at / 1000 - 1),
        )

    assert not on_channel_session_end(
        session_id="stored-1",
        completed=True,
        interrupted=False,
        database_path=database_path,
        profile_home=profile_home,
    )
    assert scheduler.get(turn.id).state == "running"


def test_stream_boundary_heartbeats_the_bound_turn(tmp_path):
    database_path, repo, scheduler, turn = _running_turn(tmp_path)
    with repo.database.connect() as connection:
        before = connection.execute(
            "select updated_at from turns where id = ?", (turn.id,)
        ).fetchone()[0]
        connection.execute(
            "update turns set updated_at = updated_at - 1000 where id = ?", (turn.id,)
        )

    assert on_channel_stream_boundary(
        session_id="stored-1",
        database_path=database_path,
    )

    with repo.database.connect() as connection:
        after = connection.execute(
            "select updated_at from turns where id = ?", (turn.id,)
        ).fetchone()[0]
    assert after >= before


def test_plugin_registers_durable_channel_lifecycle_hooks():
    class Context:
        def __init__(self):
            self.hooks = []
            self.platforms = []

        def register_hook(self, name, callback):
            self.hooks.append((name, callback))

        def register_platform(self, **kwargs):
            self.platforms.append(kwargs)

    context = Context()
    _plugin_register()(context)

    assert {name for name, _ in context.hooks} == {
        "post_llm_call",
        "on_session_end",
        "on_stream_start",
        "on_stream_end",
        "transform_tool_result",
        "pre_tool_call",
    }
    assert context.platforms[0]["name"] == "channels"
