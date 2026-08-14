"""The crew platform adapter posts through the normal routing pipeline."""

import importlib.util
import sys
from pathlib import Path

import pytest

from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.repositories import CrewRepository

ROOT = Path(__file__).resolve().parents[2]


def _load_adapter():
    spec = importlib.util.spec_from_file_location(
        "crew_platform_adapter", ROOT / "plugin" / "platform_adapter.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def crew_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "channels").mkdir(parents=True)
    repository = CrewRepository(CrewDatabase(tmp_path / "channels" / "channels.db"))
    channel = repository.create_channel(
        "general", default_responder_profile="atlas"
    )
    repository.add_member(channel.id, "atlas", activation_policy="mentioned")
    repository.add_member(channel.id, "freya", activation_policy="mentioned")
    return repository, channel


def test_check_and_listing(crew_home):
    adapter = _load_adapter()
    assert adapter.check_requirements() is True
    assert adapter.list_crew_channels() == [
        {"id": crew_home[1].id, "name": "general"}
    ]
    assert adapter.env_enablement() is not None


def test_home_channel_uses_gateway_chat_id(crew_home, monkeypatch):
    monkeypatch.setenv("CHANNELS_HOME_CHANNEL", "#general")
    adapter = _load_adapter()
    assert adapter.env_enablement()["home_channel"] == {
        "chat_id": "#general",
        "name": "general",
    }


def test_post_routes_mentions_and_default_responder(crew_home):
    repository, channel = crew_home
    adapter = _load_adapter()

    result = adapter.post_to_channel("#general", "@freya please review the draft")
    assert result["channel"] == "general"
    # Directed messages wake ONLY the mentioned member — the default
    # responder covers untagged messages.
    assert result["turns"] == ["freya"]

    plain = adapter.post_to_channel(channel.id, "status update, no mentions")
    assert plain["turns"] == ["atlas"]

    with pytest.raises(KeyError):
        adapter.post_to_channel("nope", "hello")


@pytest.mark.asyncio
async def test_standalone_send_contract(crew_home):
    repository, _channel = crew_home
    adapter = _load_adapter()
    ok = await adapter.standalone_send(None, "general", "@all sync up")
    assert ok["success"] is True and ok["message_id"]
    bad = await adapter.standalone_send(None, "missing", "x")
    assert "error" in bad

    threaded = await adapter.standalone_send(
        None, "general", "reply", thread_id=ok["message_id"]
    )
    thread = repository.get_thread(ok["message_id"])
    assert threaded["success"] is True
    assert [message.content for message in thread] == ["@all sync up", "reply"]

    unsupported = await adapter.standalone_send(
        None, "general", "file", media_files=["report.pdf"]
    )
    assert unsupported == {"error": "channels does not support media attachments"}
