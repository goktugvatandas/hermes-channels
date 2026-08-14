"""Channel kanban routes: mapping, card lifecycle, and host-store isolation."""

import itertools
import time

from fastapi import FastAPI
import httpx
import pytest

from hermes_channels_backend.api import create_router
from hermes_channels_backend.kanban_bridge import (
    BOARD_MAP_SETTING,
    CARD_STATUSES,
    KanbanBridge,
    default_board_slug,
)


PREFIX = "/api/plugins/hermes-channels"


class FakeKanbanBridge(KanbanBridge):
    """In-memory stand-in for the host kanban store."""

    def __init__(self):
        super().__init__(bindings=object())
        self.boards: dict[str, dict[str, dict]] = {}
        self._ids = itertools.count(1)

    def ensure_board(self, slug, *, display_name=None):
        self.boards.setdefault(slug, {})

    def board_exists(self, slug):
        return slug in self.boards

    def list_boards(self):
        return [{"slug": slug, "name": slug} for slug in sorted(self.boards)]

    def switch_current_board(self, slug):
        self.current_board = slug

    def edit_card(self, slug, task_id, *, title=None, body=None, priority=None):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None:
            raise KeyError(f"unknown card: {task_id}")
        if title is not None:
            if not title.strip():
                raise ValueError("title cannot be empty")
            card["title"] = title.strip()
        if body is not None:
            card["body"] = body
        if priority is not None:
            card["priority"] = int(priority)
        return {key: value for key, value in card.items() if key != "comments"}

    def assign_card(self, slug, task_id, assignee):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None:
            raise KeyError(f"unknown card: {task_id}")
        card["assignee"] = assignee
        return {key: value for key, value in card.items() if key != "comments"}

    def snapshot(self, slug):
        cards = list(self.boards.get(slug, {}).values())
        return {
            "boardSlug": slug,
            "boardName": slug,
            "statuses": list(CARD_STATUSES),
            "cards": cards,
        }

    def get_card(self, slug, task_id):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None:
            raise KeyError(f"unknown card: {task_id}")
        return {**card, "comments": card.get("comments", [])}

    def create_card(self, slug, *, title, body=None, assignee=None, priority=0,
                    triage=False, created_by=None, idempotency_key=None):
        card = {
            "id": f"task-{next(self._ids)}",
            "title": title,
            "body": body,
            "status": "triage" if triage else "ready",
            "assignee": assignee,
            "priority": priority,
            "createdBy": created_by,
            "projectId": None,
            "result": None,
            "blockKind": None,
            "createdAt": int(time.time()),
            "startedAt": None,
            "completedAt": None,
            "comments": [],
        }
        self.boards.setdefault(slug, {})[card["id"]] = card
        return {key: value for key, value in card.items() if key != "comments"}

    def _transition(self, slug, task_id, status, **extra):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None:
            raise KeyError(f"unknown card: {task_id}")
        card.update(status=status, **extra)
        return {key: value for key, value in card.items() if key != "comments"}

    def complete_card(self, slug, task_id, *, result=None):
        card = self.boards.get(slug, {}).get(task_id)
        if card is not None and card["status"] == "done":
            raise ValueError("already done")
        return self._transition(slug, task_id, "done", result=result)

    def block_card(self, slug, task_id, *, reason=None):
        return self._transition(slug, task_id, "blocked")

    def unblock_card(self, slug, task_id):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None or card["status"] != "blocked":
            raise ValueError(f"card is not blocked: {task_id}")
        return self._transition(slug, task_id, "ready")

    def comment_card(self, slug, task_id, *, author, body):
        card = self.boards.get(slug, {}).get(task_id)
        if card is None:
            raise KeyError(f"unknown card: {task_id}")
        card.setdefault("comments", []).append(
            {"id": next(self._ids), "author": author, "body": body,
             "createdAt": int(time.time())}
        )
        return self.get_card(slug, task_id)

    def delete_card(self, slug, task_id):
        if self.boards.get(slug, {}).pop(task_id, None) is None:
            raise KeyError(f"unknown card: {task_id}")


def _app(tmp_path, bridge) -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_router(tmp_path / "channels.db", kanban_bridge=bridge),
        prefix=PREFIX,
    )
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


async def _create_channel(client, name="general") -> dict:
    response = await client.post(
        f"{PREFIX}/channels",
        json={
            "name": name,
            "purpose": "Coordinate work",
            "defaultResponderProfile": "atlas",
            "members": [{"profileId": "atlas", "activationPolicy": "always"}],
        },
    )
    assert response.status_code == 201
    return response.json()


async def _bind_board(client, channel_id: str, slug: str) -> dict:
    response = await client.put(
        f"{PREFIX}/channels/{channel_id}/kanban/board", json={"boardSlug": slug}
    )
    assert response.status_code == 200
    return response.json()


def test_default_board_slug_follows_channel_name():
    assert default_board_slug("seatech") == "channel-seatech"


@pytest.mark.asyncio
async def test_unbound_channel_offers_create_or_connect(tmp_path):
    bridge = FakeKanbanBridge()
    bridge.boards["existing-board"] = {}
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        response = await client.get(f"{PREFIX}/channels/{channel['id']}/kanban")
        assert response.status_code == 200
        payload = response.json()
        assert payload["bound"] is False
        assert payload["suggestedSlug"] == "channel-general"
        assert payload["boards"] == [{"slug": "existing-board", "name": "existing-board"}]
        # No board silently materializes for a channel nobody opted into.
        assert "channel-general" not in bridge.boards
        # Card mutations without a board are a clear client error.
        created = await client.post(
            f"{PREFIX}/channels/{channel['id']}/kanban/cards", json={"title": "x"}
        )
        assert created.status_code == 409


@pytest.mark.asyncio
async def test_binding_conventional_slug_creates_the_board(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        bound = await _bind_board(client, channel["id"], "channel-general")
        assert bound["bound"] is True
        assert bound["boardSlug"] == "channel-general"
        assert "channel-general" in bridge.boards


@pytest.mark.asyncio
async def test_connecting_an_existing_board_reuses_it(tmp_path):
    bridge = FakeKanbanBridge()
    bridge.create_card("my-old-board", title="pre-existing work")
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        bound = await _bind_board(client, channel["id"], "my-old-board")
        assert bound["boardSlug"] == "my-old-board"
        assert [card["title"] for card in bound["cards"]] == ["pre-existing work"]


@pytest.mark.asyncio
async def test_assign_card_route(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"
        card = (await client.post(f"{base}/cards", json={"title": "assign me"})).json()
        assigned = await client.post(
            f"{base}/cards/{card['id']}/assign", json={"assignee": "forge"}
        )
        assert assigned.status_code == 200
        assert assigned.json()["assignee"] == "forge"
        cleared = await client.post(
            f"{base}/cards/{card['id']}/assign", json={"assignee": None}
        )
        assert cleared.json()["assignee"] is None


@pytest.mark.asyncio
async def test_card_lifecycle_create_block_unblock_complete(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"

        created = await client.post(
            f"{base}/cards", json={"title": "Ship the bridge", "priority": 2}
        )
        assert created.status_code == 201
        card = created.json()
        assert card["status"] == "ready"
        assert card["createdBy"] == "channels"

        blocked = await client.post(
            f"{base}/cards/{card['id']}/block", json={"reason": "waiting on review"}
        )
        assert blocked.json()["status"] == "blocked"

        unblocked = await client.post(f"{base}/cards/{card['id']}/unblock")
        assert unblocked.json()["status"] == "ready"

        completed = await client.post(
            f"{base}/cards/{card['id']}/complete", json={"result": "shipped"}
        )
        assert completed.json()["status"] == "done"
        assert completed.json()["result"] == "shipped"

        # Unblocking a non-blocked card is a client error, not a 500.
        again = await client.post(f"{base}/cards/{card['id']}/unblock")
        assert again.status_code == 422


@pytest.mark.asyncio
async def test_comments_use_workspace_identity(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"
        await client.patch(f"{PREFIX}/me", json={"displayName": "Göktuğ"})
        card = (await client.post(f"{base}/cards", json={"title": "note"})).json()
        commented = await client.post(
            f"{base}/cards/{card['id']}/comments", json={"body": "context here"}
        )
        assert commented.status_code == 201
        assert commented.json()["comments"][0]["author"] == "Göktuğ"

        detail = await client.get(f"{base}/cards/{card['id']}")
        assert detail.json()["comments"][0]["body"] == "context here"


@pytest.mark.asyncio
async def test_board_rebinding_persists_and_default_clears_override(tmp_path):
    bridge = FakeKanbanBridge()
    app = _app(tmp_path, bridge)
    async with _client(app) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"

        rebound = await client.put(f"{base}/board", json={"boardSlug": "shared-ops"})
        assert rebound.status_code == 200
        assert rebound.json()["boardSlug"] == "shared-ops"
        assert (await client.get(base)).json()["boardSlug"] == "shared-ops"

        # Cards land on the bound board, not the conventional one.
        await client.post(f"{base}/cards", json={"title": "on shared board"})
        assert len(bridge.boards["shared-ops"]) == 1
        assert not bridge.boards.get("channel-general")

        # Rebinding to the conventional slug removes the stored override.
        restored = await client.put(f"{base}/board", json={"boardSlug": "channel-general"})
        assert restored.json()["boardSlug"] == "channel-general"

    from hermes_channels_backend.db import CrewDatabase
    from hermes_channels_backend.repositories import CrewRepository

    repository = CrewRepository(CrewDatabase(tmp_path / "channels.db"))
    assert repository.get_setting(BOARD_MAP_SETTING) == {}


@pytest.mark.asyncio
async def test_unknown_card_maps_to_404(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"
        assert (await client.get(f"{base}/cards/nope")).status_code == 404
        assert (await client.delete(f"{base}/cards/nope")).status_code == 404


@pytest.mark.asyncio
async def test_edit_card_route(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        base = f"{PREFIX}/channels/{channel['id']}/kanban"
        card = (await client.post(f"{base}/cards", json={"title": "old title"})).json()
        edited = await client.patch(
            f"{base}/cards/{card['id']}",
            json={"title": "new title", "body": "spec", "priority": 3},
        )
        assert edited.status_code == 200
        payload = edited.json()
        assert payload["title"] == "new title"
        assert payload["body"] == "spec"
        assert payload["priority"] == 3
        missing = await client.patch(f"{base}/cards/nope", json={"title": "x"})
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_open_switches_host_current_board(tmp_path):
    bridge = FakeKanbanBridge()
    async with _client(_app(tmp_path, bridge)) as client:
        channel = await _create_channel(client)
        await _bind_board(client, channel["id"], "channel-general")
        response = await client.post(f"{PREFIX}/channels/{channel['id']}/kanban/open")
        assert response.status_code == 200
        assert response.json() == {"boardSlug": "channel-general"}
        assert bridge.current_board == "channel-general"
