import asyncio
import json

from fastapi import FastAPI
import httpx
import pytest

from hermes_crew_backend.api import create_router
from hermes_crew_backend.models import ProjectRef


PREFIX = "/api/plugins/hermes-crew"


def _app(tmp_path, hermes_adapter=None) -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_router(tmp_path / "crew.db", hermes_adapter=hermes_adapter),
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
            "service": "hermes-crew",
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
