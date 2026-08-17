from types import SimpleNamespace

from fastapi import FastAPI
import httpx
import pytest

from hermes_channels_backend.api import create_router
from hermes_channels_backend.card_references import CardReferenceStore
from hermes_channels_backend.db import CrewDatabase


PREFIX = "/api/plugins/hermes-channels"


class BoardCatalog:
    def __init__(self):
        self.snapshots = []

    def list_boards(self):
        return [
            {"slug": "channel-seatech", "name": "SellerDoping"},
            {"slug": "channel-circle", "name": "Circle"},
            {"slug": "channel-new-venture", "name": "New Venture"},
        ]

    def snapshot(self, slug):
        self.snapshots.append(slug)
        return {"cards": []}


def _app(tmp_path, catalog=None):
    app = FastAPI()
    app.include_router(
        create_router(tmp_path / "channels.db", kanban_bridge=catalog or BoardCatalog()),
        prefix=PREFIX,
    )
    return app


def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


@pytest.mark.asyncio
async def test_settings_list_generated_prefix_for_every_board(tmp_path):
    async with _client(_app(tmp_path)) as client:
        response = await client.get(f"{PREFIX}/card-prefixes")

    assert response.status_code == 200
    assert response.json() == [
        {
            "boardSlug": "channel-circle",
            "boardName": "Circle",
            "prefix": "CI",
            "generatedPrefix": "CI",
            "customized": False,
            "cardCount": 0,
        },
        {
            "boardSlug": "channel-new-venture",
            "boardName": "New Venture",
            "prefix": "NV",
            "generatedPrefix": "NV",
            "customized": False,
            "cardCount": 0,
        },
        {
            "boardSlug": "channel-seatech",
            "boardName": "SellerDoping",
            "prefix": "SE",
            "generatedPrefix": "SE",
            "customized": False,
            "cardCount": 0,
        },
    ]


@pytest.mark.asyncio
async def test_settings_materializes_references_for_existing_board_cards(tmp_path):
    catalog = BoardCatalog()
    async with _client(_app(tmp_path, catalog)) as client:
        response = await client.get(f"{PREFIX}/card-prefixes")

    assert response.status_code == 200
    assert catalog.snapshots == [
        "channel-circle",
        "channel-new-venture",
        "channel-seatech",
    ]


@pytest.mark.asyncio
async def test_settings_edit_migrates_cards_and_reset_restores_generated(tmp_path):
    database_path = tmp_path / "channels.db"
    store = CardReferenceStore(CrewDatabase(database_path))
    store.ensure_references(
        "channel-seatech", [SimpleNamespace(id="t_one", created_at=1)]
    )

    async with _client(_app(tmp_path)) as client:
        changed = await client.put(
            f"{PREFIX}/card-prefixes/channel-seatech", json={"prefix": "sd"}
        )
        listed = await client.get(f"{PREFIX}/card-prefixes")
        reset = await client.put(
            f"{PREFIX}/card-prefixes/channel-seatech", json={"prefix": None}
        )

    assert changed.status_code == 200
    assert changed.json()["prefix"] == "SD"
    assert changed.json()["migratedCards"] == 1
    seatech = next(
        item for item in listed.json() if item["boardSlug"] == "channel-seatech"
    )
    assert seatech["customized"] is True
    assert seatech["prefix"] == "SD"
    assert reset.json()["prefix"] == "SE"
    assert reset.json()["customized"] is False
    assert store.reference_for("channel-seatech", "t_one") == "SE-2"


@pytest.mark.asyncio
async def test_settings_rejects_invalid_prefix_and_unknown_board(tmp_path):
    async with _client(_app(tmp_path)) as client:
        invalid = await client.put(
            f"{PREFIX}/card-prefixes/channel-seatech", json={"prefix": "1-bad"}
        )
        missing = await client.put(
            f"{PREFIX}/card-prefixes/channel-missing", json={"prefix": "MM"}
        )

    assert invalid.status_code == 422
    assert missing.status_code == 404
