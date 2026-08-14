"""Channels as a Hermes messaging platform.

Registers ``Platform("channels")`` so crew channels are first-class send targets
across the host: the agent ``send_message`` tool (any agent, any session, can
post into a crew channel), ``hermes send --to channels:<channel>``, cron
``deliver=channels`` jobs, the Channels settings page, and the channel directory.

The adapter is intentionally one-directional. Inbound orchestration (waking
agents, budgets, envelopes) stays with Crew's own router and scheduler — a
"send" here appends a message to channels.db through the exact pipeline a human
composer post uses, and the normal Crew workers pick up the resulting turns.
Messages arriving through this door are recorded as user-authored, matching
how bridge platforms treat remote senders.
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

PLATFORM_NAME = "channels"
HOME_CHANNEL_ENV = "CHANNELS_HOME_CHANNEL"


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _database_path() -> Path:
    return _hermes_home() / "channels" / "channels.db"


def check_requirements() -> bool:
    """Passive probe: installed when the workspace exists. The installer only
    creates the directory — the database appears on first backend use — so
    the directory alone must count or a fresh install fails its own probe."""

    database = _database_path()
    return database.exists() or database.parent.is_dir()


def _ensure_backend_importable() -> None:
    dashboard = str(Path(__file__).resolve().parent / "dashboard")
    if dashboard not in sys.path:
        sys.path.insert(0, dashboard)


# Mention parsing lives in hermes_channels_backend.routing.scan_mentions —
# one grammar for the composer path, the router fallback, and this door.


def list_crew_channels() -> List[Dict[str, str]]:
    _ensure_backend_importable()
    from hermes_channels_backend.db import CrewDatabase
    from hermes_channels_backend.repositories import CrewRepository

    repository = CrewRepository(CrewDatabase(_database_path()))
    return [
        {"id": channel.id, "name": channel.name}
        for channel in repository.list_channels()
    ]


def _resolve_channel(repository: Any, channel_ref: str):
    """One reference grammar: channel id, name, or #name."""

    ref = (channel_ref or "").strip().lstrip("#")
    return next(
        (
            candidate
            for candidate in repository.list_channels()
            if candidate.id == channel_ref or candidate.name == ref
        ),
        None,
    )


def post_to_channel(
    channel_ref: str, content: str, *, thread_id: str | None = None
) -> Dict[str, Any]:
    """Post into a channel (by id, name, or #name) and route turns."""

    _ensure_backend_importable()
    from hermes_channels_backend.classifier import Classifier
    from hermes_channels_backend.db import CrewDatabase
    from hermes_channels_backend.repositories import CrewRepository
    from hermes_channels_backend.routing import Router, scan_mentions
    from hermes_channels_backend.scheduler import Scheduler

    repository = CrewRepository(CrewDatabase(_database_path()))
    channel = _resolve_channel(repository, channel_ref)
    if channel is None:
        raise KeyError(f"unknown channel: {channel_ref!r}")

    message = repository.append_message(
        channel.id,
        "user",
        content,
        idempotency_key=f"platform:{int(time.time())}:{uuid.uuid4().hex[:8]}",
        mentions=scan_mentions(repository, channel.id, content),
        root_message_id=thread_id,
    )
    # Same pipeline as the composer: the classifier gets first look (it
    # enqueues its own judgment claim when the channel enables it), then the
    # router plans under the normal budgets.
    Classifier(repository).plan(message.id)
    scheduler = Scheduler(repository)
    turns = [
        scheduler.enqueue(planned)
        for planned in Router(repository).plan(message.id)
    ]
    return {
        "message_id": message.id,
        "channel": channel.name,
        "turns": [turn.profile_id for turn in turns],
    }


def parse_target_ref(ref: str):
    """Resolve ``channels:<channel>`` send targets without a live gateway: accept
    a channel id, name, or #name and normalize to the channel id."""

    cleaned = (ref or "").strip().lstrip("#")
    if not cleaned:
        return None
    try:
        for channel in list_crew_channels():
            if channel["id"] == ref or channel["name"] == cleaned:
                return (channel["id"], None)
    except Exception:
        return None
    return None


def env_enablement() -> Optional[dict]:
    """Auto-enable when a Crew workspace exists on this machine."""

    if not check_requirements():
        return None
    seed: dict = {"database": str(_database_path())}
    home = os.getenv(HOME_CHANNEL_ENV, "").strip()
    if home:
        # HomeChannel reads chat_id (gateway/config.py) — id is ignored.
        seed["home_channel"] = {"chat_id": home, "name": home.lstrip("#")}
    return seed


async def standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Out-of-process delivery for cron jobs and send tools without a live
    gateway adapter — channels.db is local, so this is a direct post."""

    if media_files:
        return {"error": "channels does not support media attachments"}
    try:
        result = post_to_channel(chat_id, message, thread_id=thread_id)
        return {"success": True, "message_id": result["message_id"]}
    except Exception as error:  # noqa: BLE001 - contract wants {"error": ...}
        return {"error": f"channels send failed: {error}"}


def make_adapter(config: Any) -> Any:
    """Adapter factory — gateway imports stay lazy so the module loads in
    non-gateway processes (dashboard, tests) without the gateway package."""

    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class CrewAdapter(BasePlatformAdapter):
        """Send/list-only adapter: Crew has no inbound event stream to pump —
        its own workers consume the turns that a posted message schedules."""

        def __init__(self, cfg: Any):
            super().__init__(config=cfg, platform=Platform(PLATFORM_NAME))

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            return check_requirements()

        async def disconnect(self) -> None:
            return None

        async def send(
            self,
            chat_id: str,
            content: str,
            reply_to: Optional[str] = None,
            metadata: Optional[Dict[str, Any]] = None,
        ) -> SendResult:
            try:
                result = post_to_channel(chat_id, content, thread_id=reply_to)
                return SendResult(success=True, message_id=result["message_id"])
            except Exception as error:  # noqa: BLE001 - SendResult carries it
                return SendResult(success=False, error=str(error))

        async def list_channels(self) -> List[Dict[str, str]]:
            return list_crew_channels()

    return CrewAdapter(config)
