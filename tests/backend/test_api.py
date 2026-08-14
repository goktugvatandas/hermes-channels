import asyncio
import json
import time

from fastapi import FastAPI
import httpx
import pytest

from hermes_channels_backend.api import _resolve_session_store, create_router
from hermes_channels_backend.db import CrewDatabase
from hermes_channels_backend.models import ProjectRef
from hermes_channels_backend.repositories import CrewRepository
from hermes_channels_backend.routing import Router
from hermes_channels_backend.scheduler import Scheduler


PREFIX = "/api/plugins/hermes-channels"


def _app(tmp_path, hermes_adapter=None) -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_router(tmp_path / "channels.db", hermes_adapter=hermes_adapter),
        prefix=PREFIX,
    )
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


async def _create_channel(client: httpx.AsyncClient) -> dict:
    response = await client.post(
        f"{PREFIX}/channels",
        json={
            "name": "general",
            "purpose": "Coordinate work",
            "defaultResponderProfile": "atlas",
            "members": [
                {"profileId": "atlas", "activationPolicy": "mentioned"}
            ],
        },
    )
    assert response.status_code == 201
    return response.json()


@pytest.mark.asyncio
async def test_health_channel_message_idempotency_and_thread_routes(tmp_path):
    """The scoped API must preserve one message command and its thread view."""
    async with _client(_app(tmp_path)) as client:
        assert (await client.get(f"{PREFIX}/health")).json() == {
            "ok": True,
            "service": "hermes-channels",
        }
        channel = await _create_channel(client)
        patched = await client.patch(
            f"{PREFIX}/channels/{channel['id']}",
            json={"topic": "v1 implementation"},
        )
        assert patched.status_code == 200
        assert patched.json()["topic"] == "v1 implementation"
        cleared = await client.patch(
            f"{PREFIX}/channels/{channel['id']}",
            json={"defaultResponderProfile": None},
        )
        assert cleared.json()["defaultResponderProfile"] is None
        await client.patch(
            f"{PREFIX}/channels/{channel['id']}",
            json={"defaultResponderProfile": "atlas"},
        )

        body = {
            "content": "Implement it",
            "idempotencyKey": "composer-1",
            "mentions": ["atlas"],
            "project": {"mode": "global"},
        }
        first = await client.post(
            f"{PREFIX}/channels/{channel['id']}/messages", json=body
        )
        duplicate = await client.post(
            f"{PREFIX}/channels/{channel['id']}/messages", json=body
        )

        assert first.status_code == duplicate.status_code == 201
        assert duplicate.json()["message"]["id"] == first.json()["message"]["id"]
        messages = (
            await client.get(f"{PREFIX}/channels/{channel['id']}/messages")
        ).json()
        assert [message["content"] for message in messages] == ["Implement it"]
        thread = (
            await client.get(
                f"{PREFIX}/threads/{first.json()['message']['id']}"
            )
        ).json()
        assert [message["content"] for message in thread] == ["Implement it"]


@pytest.mark.asyncio
async def test_studio_member_behavior_and_classifier_routes(tmp_path):
    """Crew Studio fields stay local while profile-owned fields remain in Hermes."""
    async with _client(_app(tmp_path)) as client:
        channel = await _create_channel(client)

        member = await client.patch(
            f"{PREFIX}/members/atlas",
            json={"displayName": "Atlas", "role": "Engineer", "color": "blue"},
        )
        assert member.status_code == 200
        assert member.json()["role"] == "Engineer"

        activation = await client.put(
            f"{PREFIX}/channels/{channel['id']}/members/atlas",
            json={"activationPolicy": "always"},
        )
        assert activation.status_code == 200
        assert activation.json()["activationPolicy"] == "always"
        presentation = (await client.get(f"{PREFIX}/members/atlas")).json()
        assert presentation["displayName"] == "Atlas"
        assert presentation["role"] == "Engineer"
        assert (await client.get(f"{PREFIX}/channels/{channel['id']}/members")).json() == [
            {
                "channelId": channel["id"],
                "profileId": "atlas",
                "activationPolicy": "always",
            }
        ]

        default_classifier = (
            await client.get(f"{PREFIX}/channels/{channel['id']}/classifier")
        ).json()
        assert default_classifier["enabled"] is False
        configured = await client.put(
            f"{PREFIX}/channels/{channel['id']}/classifier",
            json={
                "enabled": True,
                "provider": "openai",
                "model": "gpt-5-mini",
                "reasoningEffort": "low",
                "maxTokens": 250,
                "confidenceThreshold": 0.7,
            },
        )
        assert configured.json()["model"] == "gpt-5-mini"


@pytest.mark.asyncio
async def test_first_run_is_one_idempotent_backend_command(tmp_path):
    """Onboarding must not leave a half-created channel or enabled classifier."""
    async with _client(_app(tmp_path)) as client:
        body = {
            "defaultResponderProfile": "atlas",
            "profiles": ["atlas", "scout"],
        }
        first = await client.post(f"{PREFIX}/onboarding", json=body)
        second = await client.post(f"{PREFIX}/onboarding", json=body)

        assert first.status_code == second.status_code == 200
        assert second.json()["id"] == first.json()["id"]
        channels = (await client.get(f"{PREFIX}/channels")).json()
        assert [channel["name"] for channel in channels] == ["general"]
        members = (
            await client.get(f"{PREFIX}/channels/{first.json()['id']}/members")
        ).json()
        assert [(item["profileId"], item["activationPolicy"]) for item in members] == [
            ("atlas", "always"),
            ("scout", "mentioned"),
        ]
        classifier = (
            await client.get(f"{PREFIX}/channels/{first.json()['id']}/classifier")
        ).json()
        assert classifier["enabled"] is False


@pytest.mark.asyncio
async def test_search_filters_message_and_activity_documents(tmp_path):
    """Search facets must narrow the FTS index without leaking other channels."""
    async with _client(_app(tmp_path)) as client:
        general = await _create_channel(client)
        web = (
            await client.post(
                f"{PREFIX}/channels",
                json={
                    "name": "web",
                    "members": [
                        {"profileId": "scout", "activationPolicy": "always"}
                    ],
                },
            )
        ).json()
        await client.post(
            f"{PREFIX}/channels/{general['id']}/messages",
            json={"content": "Investigate database latency", "idempotencyKey": "search-1"},
        )
        receipt = (
            await client.post(
                f"{PREFIX}/channels/{web['id']}/messages",
                json={
                    "content": "Audit web rendering",
                    "idempotencyKey": "search-2",
                    "project": {
                        "mode": "project",
                        "profile": "scout",
                        "projectId": "p-web",
                        "label": "Web",
                        "cwd": "/work/web",
                    },
                },
            )
        ).json()
        turn_id = receipt["turnIds"][0]
        await client.post(f"{PREFIX}/turns/{turn_id}/cancel")

        text_results = (
            await client.get(f"{PREFIX}/search", params={"q": "rendering"})
        ).json()
        assert [(item["kind"], item["channelId"]) for item in text_results] == [
            ("message", web["id"])
        ]
        project_results = (
            await client.get(
                f"{PREFIX}/search",
                params={"project": "p-web", "channelId": web["id"]},
            )
        ).json()
        assert any(item["text"] == "Audit web rendering" for item in project_results)
        state_results = (
            await client.get(
                f"{PREFIX}/search",
                params={"state": "cancelled", "member": "scout"},
            )
        ).json()
        assert len(state_results) == 1
        assert state_results[0]["kind"] == "activity"


@pytest.mark.asyncio
async def test_dispatch_approval_completion_cancel_retry_and_activity_cursor(tmp_path):
    """Desktop worker control routes must operate on one durable turn at a time."""
    async with _client(_app(tmp_path)) as client:
        channel = await _create_channel(client)
        posted = (
            await client.post(
                f"{PREFIX}/channels/{channel['id']}/messages",
                json={"content": "Run it", "idempotencyKey": "composer-2"},
            )
        ).json()
        turn_id = posted["turnIds"][0]
        claim = await client.post(
            f"{PREFIX}/dispatch/claim", json={"workerId": "desktop-a"}
        )
        assert claim.status_code == 200
        assert claim.json()["id"] == turn_id
        assert (
            await client.post(
                f"{PREFIX}/dispatch/{turn_id}/session",
                json={"runtimeSessionId": "runtime-1", "storedSessionId": "s-1"},
            )
        ).status_code == 200
        approval = (
            await client.post(
                f"{PREFIX}/dispatch/{turn_id}/events",
                json={
                    "type": "approval_request",
                    "payload": {"requestId": "approval-1", "prompt": "Allow?"},
                },
            )
        ).json()
        assert (
            await client.post(
                f"{PREFIX}/approvals/{approval['id']}/resolve",
                json={"decision": "reject", "note": "No"},
            )
        ).status_code == 200
        completed = await client.post(
            f"{PREFIX}/dispatch/{turn_id}/complete",
            json={
                "visibleText": "Stopped safely",
                "envelope": {"schemaVersion": 1, "intent": "result"},
            },
        )
        assert completed.status_code == 200
        assert completed.json()["state"] == "completed"

        second = (
            await client.post(
                f"{PREFIX}/channels/{channel['id']}/messages",
                json={"content": "Try another", "idempotencyKey": "composer-3"},
            )
        ).json()["turnIds"][0]
        assert (
            await client.post(f"{PREFIX}/turns/{second}/cancel")
        ).json()["state"] == "cancelled"
        retry = await client.post(f"{PREFIX}/turns/{second}/retry")
        assert retry.status_code == 201
        assert retry.json()["retryOf"] == second

        activity = (
            await client.get(f"{PREFIX}/events", params={"after": 0})
        ).json()
        assert [frame["sequence"] for frame in activity] == sorted(
            frame["sequence"] for frame in activity
        )
        assert any(frame["type"] == "approval_resolved" for frame in activity)


@pytest.mark.asyncio
async def test_dispatch_failure_is_durable_and_visible_to_the_activity_journal(tmp_path):
    """Gateway readiness errors must release claimed work instead of stranding it."""
    async with _client(_app(tmp_path)) as client:
        channel = await _create_channel(client)
        posted = (
            await client.post(
                f"{PREFIX}/channels/{channel['id']}/messages",
                json={"content": "Run it", "idempotencyKey": "composer-fail"},
            )
        ).json()
        turn_id = posted["turnIds"][0]
        await client.post(
            f"{PREFIX}/dispatch/claim", json={"workerId": "desktop-a"}
        )

        failed = await client.post(
            f"{PREFIX}/dispatch/{turn_id}/fail",
            json={"error": "profile atlas has no configured model"},
        )

        assert failed.status_code == 200
        assert failed.json()["state"] == "failed"
        activity = (await client.get(f"{PREFIX}/events", params={"after": 0})).json()
        assert activity[-1]["type"] == "failed"
        assert activity[-1]["payload"] == {
            "error": "profile atlas has no configured model"
        }


@pytest.mark.asyncio
async def test_backend_restart_reaps_only_stale_claimed_work(tmp_path):
    """Both hosts share channels.db: a booting backend keeps fresh in-flight turns
    (they may belong to the other live host) and reaps only journal-silent
    ones. Regression: it used to blanket-interrupt everything in flight."""
    import sqlite3 as _sqlite3

    first_app = _app(tmp_path)
    async with _client(first_app) as client:
        channel = await _create_channel(client)
        turn_id = (
            await client.post(
                f"{PREFIX}/channels/{channel['id']}/messages",
                json={"content": "Run once", "idempotencyKey": "restart-api"},
            )
        ).json()["turnIds"][0]
        claimed = await client.post(
            f"{PREFIX}/dispatch/claim", json={"workerId": "desktop-a"}
        )
        assert claimed.json()["id"] == turn_id

    # A second backend boots while the turn is fresh: it must stay claimed.
    async with _client(_app(tmp_path)) as client:
        assert (await client.get(f"{PREFIX}/health")).status_code == 200
        activity = (await client.get(f"{PREFIX}/events", params={"after": 0})).json()
        assert all(item["type"] != "interrupted" for item in activity)

    # Backdate every trace of liveness past the staleness window; the next
    # backend (or claim poll) now treats the turn as orphaned.
    stale = int(time.time() * 1000) - 10 * 60 * 1000
    with _sqlite3.connect(tmp_path / "channels.db") as connection:
        connection.execute("UPDATE turns SET updated_at = ?", (stale,))
        connection.execute("UPDATE activity_events SET created_at = ?", (stale,))

    async with _client(_app(tmp_path)) as client:
        assert (await client.get(f"{PREFIX}/health")).status_code == 200
        activity = (await client.get(f"{PREFIX}/events", params={"after": 0})).json()
        next_claim = await client.post(
            f"{PREFIX}/dispatch/claim", json={"workerId": "desktop-b"}
        )

    assert activity[-1]["type"] == "interrupted"
    assert activity[-1]["turnId"] == turn_id
    assert next_claim.status_code == 204


@pytest.mark.asyncio
async def test_websocket_delivers_new_durable_event_and_conflicts_are_structured(tmp_path):
    """Sockets must accelerate persisted events and API conflicts need stable errors."""
    app = _app(tmp_path)
    async with _client(app) as client:
        channel = await _create_channel(client)
        conflict = await client.post(f"{PREFIX}/channels", json={"name": "general"})
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "conflict"

        incoming: asyncio.Queue[dict] = asyncio.Queue()
        outgoing: asyncio.Queue[dict] = asyncio.Queue()

        async def receive() -> dict:
            return await incoming.get()

        async def send(message: dict) -> None:
            await outgoing.put(message)

        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": f"{PREFIX}/events",
            "raw_path": f"{PREFIX}/events".encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("testclient", 123),
            "server": ("testserver", 80),
            "subprotocols": [],
            "state": {},
        }
        socket_task = asyncio.create_task(app(scope, receive, send))
        await incoming.put({"type": "websocket.connect"})
        assert (await outgoing.get())["type"] == "websocket.accept"

        await client.post(
            f"{PREFIX}/channels/{channel['id']}/messages",
            json={"content": "Wake socket", "idempotencyKey": "composer-ws"},
        )
        sent = await asyncio.wait_for(outgoing.get(), timeout=1)
        assert sent["type"] == "websocket.send"
        frame = json.loads(sent["text"])

        await incoming.put({"type": "websocket.disconnect", "code": 1000})
        socket_task.cancel()
        await asyncio.gather(socket_task, return_exceptions=True)

        assert frame["type"] == "queued"
        polled = (
            await client.get(
                f"{PREFIX}/events", params={"after": frame["sequence"] - 1}
            )
        ).json()[0]
        assert polled == frame


class StubHermesAdapter:
    def __init__(self):
        self.profile = {
            "name": "atlas",
            "provider": "openai",
            "model": "gpt-old",
            "hasEnv": True,
        }
        self.soul = "Old soul"
        self.skills = [{"name": "github", "enabled": True}]
        self.toolsets = ["terminal"]

    def list_profiles(self):
        return [self.profile]

    def create_profile(self, name, **kwargs):
        self.profile = {**self.profile, "name": name}
        return self.profile

    def get_profile(self, name):
        if name != self.profile["name"]:
            raise KeyError(name)
        return self.profile

    def update_profile(self, name, *, description=None):
        self.get_profile(name)
        self.profile["description"] = description
        return self.profile

    def read_soul(self, name):
        self.get_profile(name)
        return self.soul

    def write_soul(self, name, content):
        self.get_profile(name)
        self.soul = content
        return content

    def set_model(self, name, *, provider, model):
        self.get_profile(name)
        self.profile.update(provider=provider, model=model)
        return self.profile

    def list_skills(self, name):
        self.get_profile(name)
        return self.skills

    def set_skills(self, name, *, enabled):
        self.get_profile(name)
        self.skills = [{"name": value, "enabled": True} for value in enabled]
        return self.skills

    def list_toolsets(self, name):
        self.get_profile(name)
        return self.toolsets

    def set_toolsets(self, name, *, enabled):
        self.get_profile(name)
        self.toolsets = enabled
        return enabled

    def list_projects(self, name):
        self.get_profile(name)
        return [{"id": "p_web", "name": "Web", "primaryPath": "/work/web"}]

    def validate_project(self, name, project_id, cwd=None):
        self.get_profile(name)
        if project_id != "p_web":
            raise ValueError("unknown active project")
        return ProjectRef(
            mode="project",
            profile=name,
            project_id=project_id,
            label="Web",
            cwd="/work/web",
        )


@pytest.mark.asyncio
async def test_profile_studio_and_project_routes_delegate_without_secret_values(tmp_path):
    """Studio routes must expose independent config controls but no credential data."""
    adapter = StubHermesAdapter()
    async with _client(_app(tmp_path, adapter)) as client:
        assert (await client.get(f"{PREFIX}/profiles")).json()[0]["name"] == "atlas"
        assert (
            await client.put(
                f"{PREFIX}/profiles/atlas/model",
                json={"provider": "google", "model": "gemini-3"},
            )
        ).json()["model"] == "gemini-3"
        assert (
            await client.put(
                f"{PREFIX}/profiles/atlas/soul", json={"content": "New soul"}
            )
        ).json() == {"content": "New soul"}
        assert (
            await client.put(
                f"{PREFIX}/profiles/atlas/skills", json={"enabled": ["research"]}
            )
        ).json() == [{"name": "research", "enabled": True}]
        assert (
            await client.put(
                f"{PREFIX}/profiles/atlas/toolsets", json={"enabled": ["browser"]}
            )
        ).json() == {"enabled": ["browser"]}
        project = (
            await client.post(
                f"{PREFIX}/projects/validate",
                json={"profile": "atlas", "projectId": "p_web", "cwd": "/work/web"},
            )
        ).json()
        assert project["projectId"] == "p_web"
        assert "secret" not in repr((await client.get(f"{PREFIX}/profiles")).json())


class _FakeImageAdapter:
    """Adapter double for the avatar generation path."""

    def __init__(self, image_path):
        self.image_path = image_path
        self.prompts: list[tuple[str, str]] = []

    def image_generation_status(self):
        return {"available": True, "provider": "test-images"}

    def generate_image(
        self, prompt: str, *, aspect_ratio: str = "square", model: str | None = None
    ):
        self.prompts.append((prompt, aspect_ratio))
        self.models = getattr(self, "models", [])
        self.models.append(model)
        return {"success": True, "image": str(self.image_path)}


_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfc\xcf"
    b"\xc0\xf0\x1f\x00\x05\x05\x02\x00_\xc8\xf1\xd2\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.mark.asyncio
async def test_user_identity_roundtrip_and_member_listing(tmp_path):
    """/me persists the human identity; /members lists stored presentations."""
    async with _client(_app(tmp_path)) as client:
        assert (await client.get(f"{PREFIX}/me")).json() == {
            "displayName": "You",
            "avatar": None,
            "color": None,
        }
        patched = await client.patch(
            f"{PREFIX}/me",
            json={"displayName": "Morgan", "color": "#22639e"},
        )
        assert patched.json()["displayName"] == "Morgan"
        persisted = (await client.get(f"{PREFIX}/me")).json()
        assert persisted["color"] == "#22639e"
        assert persisted["avatar"] is None

        await client.patch(
            f"{PREFIX}/members/atlas",
            json={"avatar": "data:image/webp;base64,abc", "color": "#b03a54"},
        )
        members = (await client.get(f"{PREFIX}/members")).json()
        assert [item["profileId"] for item in members] == ["atlas"]
        assert members[0]["avatar"] == "data:image/webp;base64,abc"


@pytest.mark.asyncio
async def test_avatar_generation_stores_data_url(tmp_path):
    """Generated avatars are re-encoded as data URLs on the member record."""
    image_path = tmp_path / "gen.png"
    image_path.write_bytes(_TINY_PNG)
    adapter = _FakeImageAdapter(image_path)
    async with _client(_app(tmp_path, hermes_adapter=adapter)) as client:
        status = (await client.get(f"{PREFIX}/image-generation")).json()
        assert status == {"available": True, "provider": "test-images"}

        await client.patch(
            f"{PREFIX}/members/atlas", json={"displayName": "Atlas", "role": "Engineer"}
        )
        response = await client.post(f"{PREFIX}/members/atlas/avatar/generate")
        assert response.status_code == 200
        member = response.json()
        assert member["avatar"].startswith("data:image/")
        assert ";base64," in member["avatar"]
        # The brief is derived from the stored presentation.
        prompt, aspect = adapter.prompts[0]
        assert "Atlas" in prompt and "Engineer" in prompt
        assert aspect == "square"
        # The stored member reflects the generated avatar on later reads.
        stored = (await client.get(f"{PREFIX}/members/atlas")).json()
        assert stored["avatar"] == member["avatar"]


@pytest.mark.asyncio
async def test_avatar_generation_failure_maps_to_502(tmp_path):
    """A backend refusal surfaces as a structured 502, not a crash."""

    class _FailingAdapter(_FakeImageAdapter):
        def generate_image(self, prompt, *, aspect_ratio="square", model=None):
            return {"success": False, "error": "no credits"}

    adapter = _FailingAdapter(tmp_path / "missing.png")
    async with _client(_app(tmp_path, hermes_adapter=adapter)) as client:
        response = await client.post(f"{PREFIX}/members/atlas/avatar/generate")
        assert response.status_code == 502
        assert response.json()["message"] == "no credits"


@pytest.mark.asyncio
async def test_avatar_generation_custom_prompt_and_model(tmp_path):
    """A custom prompt is enhanced with avatar framing; the model is honored."""
    image_path = tmp_path / "gen.png"
    image_path.write_bytes(_TINY_PNG)
    adapter = _FakeImageAdapter(image_path)
    async with _client(_app(tmp_path, hermes_adapter=adapter)) as client:
        response = await client.post(
            f"{PREFIX}/members/atlas/avatar/generate",
            json={"model": "img-low", "prompt": "a fox with headphones"},
        )
        assert response.status_code == 200
        prompt, _ = adapter.prompts[0]
        assert "a fox with headphones" in prompt
        assert prompt.startswith("Square profile avatar portrait")
        assert "No text" in prompt
        assert adapter.models == ["img-low"]


@pytest.mark.asyncio
async def test_user_avatar_generation_updates_identity(tmp_path):
    """/me/avatar/generate stores the result on the user identity."""
    image_path = tmp_path / "gen.png"
    image_path.write_bytes(_TINY_PNG)
    adapter = _FakeImageAdapter(image_path)
    async with _client(_app(tmp_path, hermes_adapter=adapter)) as client:
        await client.patch(f"{PREFIX}/me", json={"displayName": "Morgan"})
        response = await client.post(f"{PREFIX}/me/avatar/generate", json={})
        assert response.status_code == 200
        body = response.json()
        assert body["displayName"] == "Morgan"
        assert body["avatar"].startswith("data:image/")
        # Default brief is derived from the stored display name.
        prompt, aspect = adapter.prompts[0]
        assert "Morgan" in prompt and aspect == "square"
        persisted = (await client.get(f"{PREFIX}/me")).json()
        assert persisted["avatar"] == body["avatar"]


@pytest.mark.asyncio
async def test_unexpected_errors_return_structured_500(tmp_path):
    """Unhandled exceptions surface a typed message, not a bare 500."""

    class _ExplodingAdapter(_FakeImageAdapter):
        def generate_image(self, prompt, *, aspect_ratio="square", model=None):
            raise RuntimeError("backend exploded")

    adapter = _ExplodingAdapter(tmp_path / "missing.png")
    async with _client(_app(tmp_path, hermes_adapter=adapter)) as client:
        response = await client.post(f"{PREFIX}/members/atlas/avatar/generate", json={})
        assert response.status_code == 500
        body = response.json()
        assert body["code"] == "internal_error"
        assert "RuntimeError: backend exploded" in body["message"]


@pytest.mark.asyncio
async def test_member_patch_rejects_bad_avatars_and_ignores_null_fields(tmp_path):
    """Avatar values are validated and explicit nulls on NOT NULL columns
    are ignored instead of surfacing as 500s/409s."""
    async with _client(_app(tmp_path)) as client:
        remote = await client.patch(
            f"{PREFIX}/members/atlas", json={"avatar": "https://evil.example/pixel.png"}
        )
        assert remote.status_code == 422

        oversized = await client.patch(
            f"{PREFIX}/members/atlas", json={"avatar": "data:image/png;base64," + "A" * 400_001}
        )
        assert oversized.status_code == 422

        await client.patch(f"{PREFIX}/members/atlas", json={"displayName": "Atlas"})
        nulls = await client.patch(
            f"{PREFIX}/members/atlas",
            json={"displayName": None, "archived": None, "color": None},
        )
        assert nulls.status_code == 200
        body = nulls.json()
        assert body["displayName"] == "Atlas"  # null ignored, not applied
        assert body["color"] is None  # nullable column: explicit null clears

        ok = await client.patch(
            f"{PREFIX}/members/atlas", json={"avatar": "data:image/webp;base64,abc"}
        )
        assert ok.status_code == 200


@pytest.mark.asyncio
async def test_events_limit_returns_newest_ascending(tmp_path):
    """?limit=N yields the newest N frames still in ascending order."""
    async with _client(_app(tmp_path)) as client:
        channel = await _create_channel(client)
        for index in range(4):
            await client.post(
                f"{PREFIX}/channels/{channel['id']}/messages",
                json={
                    "content": f"hello {index}",
                    "idempotencyKey": f"k-{index}",
                    "mentions": ["atlas"],
                },
            )
        everything = (await client.get(f"{PREFIX}/events?after=0")).json()
        limited = (
            await client.get(f"{PREFIX}/events?after=0&limit=2")
        ).json()
        assert len(limited) == 2
        assert [item["sequence"] for item in limited] == [
            item["sequence"] for item in everything[-2:]
        ]



@pytest.mark.asyncio
async def test_channel_sections_round_trip_and_validation(tmp_path):
    """Sections persist; assignments to unknown sections are dropped."""
    async with _client(_app(tmp_path)) as client:
        assert (await client.get(f"{PREFIX}/channel-sections")).json() == {
            "sections": [],
            "assignments": {},
        }
        saved = await client.put(
            f"{PREFIX}/channel-sections",
            json={
                "sections": [{"id": "proj-x", "name": "Project X"}],
                "assignments": {"chan-1": "proj-x", "chan-2": "ghost"},
            },
        )
        assert saved.status_code == 200
        assert saved.json() == {
            "sections": [{"id": "proj-x", "name": "Project X"}],
            "assignments": {"chan-1": "proj-x"},
        }
        assert (await client.get(f"{PREFIX}/channel-sections")).json()["sections"] == [
            {"id": "proj-x", "name": "Project X"}
        ]
        duplicate = await client.put(
            f"{PREFIX}/channel-sections",
            json={"sections": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}], "assignments": {}},
        )
        assert duplicate.status_code == 422


def test_profile_enablement_heals_configs(tmp_path, monkeypatch):
    """Profile configs gain plugins.enabled: hermes-channels exactly once."""
    from hermes_channels_backend import profile_enablement

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(profile_enablement, "_healed", set())
    profile = tmp_path / "profiles" / "athena"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text("model: foo\n", encoding="utf-8")

    assert profile_enablement.ensure_profiles_enabled() == 1
    text = (profile / "config.yaml").read_text(encoding="utf-8")
    assert "plugins:" in text and "- hermes-channels" in text
    # Idempotent: cached per process, and the line is never duplicated.
    monkeypatch.setattr(profile_enablement, "_healed", set())
    assert profile_enablement.ensure_profiles_enabled() == 0


@pytest.mark.asyncio
async def test_channel_member_add_remove_and_responder_guard(tmp_path):
    """Members are managed per channel; the default responder is protected."""
    async with _client(_app(tmp_path)) as client:
        channel = await _create_channel(client)
        cid = channel["id"]

        added = await client.put(
            f"{PREFIX}/channels/{cid}/members/freya",
            json={"activationPolicy": "mentioned"},
        )
        assert added.status_code == 200
        members = (await client.get(f"{PREFIX}/channels/{cid}/members")).json()
        assert {m["profileId"] for m in members} == {"atlas", "freya"}

        removed = await client.delete(f"{PREFIX}/channels/{cid}/members/freya")
        assert removed.status_code == 200
        members = (await client.get(f"{PREFIX}/channels/{cid}/members")).json()
        assert {m["profileId"] for m in members} == {"atlas"}

        guarded = await client.delete(f"{PREFIX}/channels/{cid}/members/atlas")
        assert guarded.status_code == 409
        inactive = await client.put(
            f"{PREFIX}/channels/{cid}/members/atlas",
            json={"activationPolicy": "disabled"},
        )
        assert inactive.status_code == 409
        assert (await client.delete(f"{PREFIX}/channels/{cid}/members/ghost")).status_code == 404

        await client.put(
            f"{PREFIX}/channels/{cid}/members/freya",
            json={"activationPolicy": "mentioned"},
        )
        switched = await client.patch(
            f"{PREFIX}/channels/{cid}",
            json={"defaultResponderProfile": "freya"},
        )
        assert switched.status_code == 200
        assert switched.json()["defaultResponderProfile"] == "freya"
        assert (await client.delete(
            f"{PREFIX}/channels/{cid}/members/atlas"
        )).status_code == 200


def test_session_transcript_uses_the_turn_profile_store(tmp_path):
    """Bot turns live under profiles/<name>/state.db, not the owner store."""
    home = tmp_path / "home"
    database_path = home / "channels" / "channels.db"
    database = CrewDatabase(database_path)
    repository = CrewRepository(database)
    channel = repository.create_channel(
        "general", default_responder_profile="atlas"
    )
    repository.add_member(channel.id, "atlas")
    message = repository.append_message(
        channel.id, "user", "Investigate", mentions=["atlas"]
    )
    scheduler = Scheduler(repository)
    turn = scheduler.enqueue(Router(repository).plan(message.id)[0])
    scheduler.claim("worker-1")
    scheduler.bind_session(
        turn.id, runtime_session_id="runtime-1", stored_session_id="stored-1"
    )

    assert _resolve_session_store(database_path, database, "runtime-1") == (
        home / "profiles" / "atlas" / "state.db",
        "stored-1",
    )
