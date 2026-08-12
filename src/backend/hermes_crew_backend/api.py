"""Scoped FastAPI routes mounted by Hermes at /api/plugins/hermes-crew."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from pathlib import Path
import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from .classifier import Classifier
from .db import CrewDatabase
from .event_bus import EventBus, EventFrame
from .hermes_adapter import HermesAdapter
from .models import ActivationPolicy, IntentEnvelope, ProjectRef
from .repositories import ChannelRecord, CrewRepository, MessageRecord
from .routing import Router
from .scheduler import ApprovalRecord, Scheduler, TurnRecord


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
    )


class MemberInput(ApiModel):
    profile_id: str
    activation_policy: ActivationPolicy = "mentioned"


class ChannelCreate(ApiModel):
    name: str = Field(min_length=1)
    purpose: str = ""
    topic: str = ""
    default_responder_profile: str | None = None
    default_project: ProjectRef | None = None
    members: list[MemberInput] = Field(default_factory=list)


class ChannelPatch(ApiModel):
    name: str | None = None
    purpose: str | None = None
    topic: str | None = None
    default_responder_profile: str | None = None
    default_project: ProjectRef | None = None
    allowed_projects: list[str] | None = None
    routing_rules: dict[str, Any] | None = None


class MessageCreate(ApiModel):
    content: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    mentions: list[str] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    root_message_id: str | None = None
    project: ProjectRef | None = None
    target_profile: str | None = None


class ClaimInput(ApiModel):
    worker_id: str = Field(min_length=1)


class SessionInput(ApiModel):
    runtime_session_id: str = Field(min_length=1)
    stored_session_id: str | None = None


class GatewayEventInput(ApiModel):
    type: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)


class CompletionInput(ApiModel):
    visible_text: str
    envelope: IntentEnvelope


class ClassificationInput(ApiModel):
    raw_result: str


class ApprovalInput(ApiModel):
    decision: Literal["approve", "reject"]
    note: str = ""


class ProfileCreate(ApiModel):
    name: str = Field(min_length=1)
    no_skills: bool = False
    clone_from: str | None = None
    clone_config: bool = False
    clone_all: bool = False
    description: str | None = None


class ProfilePatch(ApiModel):
    description: str | None = None


class SoulInput(ApiModel):
    content: str


class ModelInput(ApiModel):
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)


class EnabledInput(ApiModel):
    enabled: list[str]


class ProjectValidationInput(ApiModel):
    profile: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    cwd: str | None = None


class CrewRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request):
            try:
                return await original(request)
            except RequestValidationError as exc:
                fields: dict[str, list[str]] = {}
                for error in exc.errors():
                    field = ".".join(str(part) for part in error["loc"] if part != "body")
                    fields.setdefault(field or "body", []).append(error["msg"])
                return JSONResponse(
                    status_code=422,
                    content={
                        "code": "validation_error",
                        "message": "Request validation failed",
                        "fieldErrors": fields,
                    },
                )
            except sqlite3.IntegrityError as exc:
                return _error(409, "conflict", str(exc))
            except KeyError as exc:
                return _error(404, "not_found", exc.args[0] if exc.args else str(exc))
            except ValueError as exc:
                return _error(422, "validation_error", str(exc))

        return handler


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message, "fieldErrors": {}},
    )


@dataclass(slots=True)
class BackendServices:
    database_path: Path
    database: CrewDatabase | None = None
    repository: CrewRepository | None = None
    bus: EventBus | None = None
    scheduler: Scheduler | None = None
    adapter: HermesAdapter | None = None

    def load(self) -> "BackendServices":
        if self.database is None:
            self.database = CrewDatabase(self.database_path)
            self.repository = CrewRepository(self.database)
            self.bus = EventBus()
            self.scheduler = Scheduler(self.repository, event_bus=self.bus)
        if self.adapter is None:
            self.adapter = HermesAdapter()
        return self


def _default_database_path() -> Path:
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return hermes_home / "crew" / "crew.db"


def _channel(record: ChannelRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "name": record.name,
        "purpose": record.purpose,
        "topic": record.topic,
        "defaultResponderProfile": record.default_responder_profile,
        "defaultProject": record.default_project.model_dump(by_alias=True)
        if record.default_project
        else None,
        "allowedProjects": list(record.allowed_projects),
        "routingRules": record.routing_rules,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    }


def _message(record: MessageRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "channelId": record.channel_id,
        "rootMessageId": record.root_message_id,
        "parentMessageId": record.parent_message_id,
        "authorType": record.author_type,
        "authorProfileId": record.author_profile_id,
        "targetProfile": record.target_profile,
        "content": record.content,
        "idempotencyKey": record.idempotency_key,
        "mentions": list(record.mentions),
        "project": record.project.model_dump(by_alias=True) if record.project else None,
        "intentEnvelope": record.intent_envelope,
        "modelLabel": record.model_label,
        "createdAt": record.created_at,
    }


def _turn(record: TurnRecord) -> dict[str, Any]:
    raw = asdict(record)
    return {_camel(key): value for key, value in raw.items()}


def _frame(frame: EventFrame) -> dict[str, Any]:
    return {
        "sequence": frame.sequence,
        "type": frame.type,
        "channelId": frame.channel_id,
        "turnId": frame.turn_id,
        "payload": frame.payload,
    }


def _approval(record: ApprovalRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "turnId": record.turn_id,
        "requestId": record.request_id,
        "state": record.state,
        "payload": record.payload,
        "decision": record.decision,
        "note": record.note,
    }


def create_router(
    database_path: str | Path | None = None,
    *,
    hermes_adapter: HermesAdapter | None = None,
) -> APIRouter:
    services = BackendServices(
        Path(database_path or _default_database_path()), adapter=hermes_adapter
    )
    api = APIRouter(route_class=CrewRoute)

    def loaded() -> BackendServices:
        return services.load()

    @api.get("/health")
    async def health() -> dict[str, Any]:
        loaded()
        return {"ok": True, "service": "hermes-crew"}

    @api.get("/channels")
    async def list_channels() -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        return [_channel(item) for item in service.repository.list_channels()]

    @api.post("/channels", status_code=201)
    async def create_channel(body: ChannelCreate) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        channel = service.repository.create_channel(
            body.name,
            purpose=body.purpose,
            topic=body.topic,
            default_responder_profile=body.default_responder_profile,
            default_project=body.default_project,
        )
        for member in body.members:
            service.repository.add_member(
                channel.id,
                member.profile_id,
                activation_policy=member.activation_policy,
            )
        return _channel(channel)

    @api.patch("/channels/{channel_id}")
    async def patch_channel(channel_id: str, body: ChannelPatch) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        clearable = {"default_responder_profile", "default_project"}
        changes = {
            field: value
            for field, value in body.model_dump(exclude_unset=True).items()
            if value is not None or field in clearable
        }
        return _channel(service.repository.update_channel(channel_id, **changes))

    @api.get("/channels/{channel_id}/messages")
    async def list_messages(channel_id: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        service.repository.require_channel(channel_id)
        return [_message(item) for item in service.repository.list_messages(channel_id)]

    @api.post("/channels/{channel_id}/messages", status_code=201)
    async def create_message(channel_id: str, body: MessageCreate) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None and service.scheduler is not None
        message = service.repository.append_message(
            channel_id,
            "user",
            body.content,
            idempotency_key=body.idempotency_key,
            mentions=body.mentions,
            attachments=body.attachments,
            root_message_id=body.root_message_id,
            project=body.project,
            target_profile=body.target_profile,
        )
        Classifier(service.repository).plan(message.id)
        turns = [
            service.scheduler.enqueue(planned)
            for planned in Router(service.repository).plan(message.id)
        ]
        return {"message": _message(message), "turnIds": [turn.id for turn in turns]}

    @api.get("/threads/{root_message_id}")
    async def get_thread(root_message_id: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        return [
            _message(item) for item in service.repository.get_thread(root_message_id)
        ]

    @api.get("/profiles")
    async def list_profiles() -> list[dict[str, Any]]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.list_profiles()

    @api.post("/profiles", status_code=201)
    async def create_profile(body: ProfileCreate) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.create_profile(
            body.name,
            no_skills=body.no_skills,
            clone_from=body.clone_from,
            clone_config=body.clone_config,
            clone_all=body.clone_all,
            description=body.description,
        )

    @api.get("/profiles/{name}")
    async def get_profile(name: str) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.get_profile(name)

    @api.patch("/profiles/{name}")
    async def patch_profile(name: str, body: ProfilePatch) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.update_profile(name, description=body.description)

    @api.get("/profiles/{name}/soul")
    async def get_soul(name: str) -> dict[str, str]:
        service = loaded()
        assert service.adapter is not None
        return {"content": service.adapter.read_soul(name)}

    @api.put("/profiles/{name}/soul")
    async def put_soul(name: str, body: SoulInput) -> dict[str, str]:
        service = loaded()
        assert service.adapter is not None
        return {"content": service.adapter.write_soul(name, body.content)}

    @api.put("/profiles/{name}/model")
    async def put_model(name: str, body: ModelInput) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.set_model(name, provider=body.provider, model=body.model)

    @api.get("/profiles/{name}/skills")
    async def get_skills(name: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.list_skills(name)

    @api.put("/profiles/{name}/skills")
    async def put_skills(name: str, body: EnabledInput) -> list[dict[str, Any]]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.set_skills(name, enabled=body.enabled)

    @api.get("/profiles/{name}/toolsets")
    async def get_toolsets(name: str) -> dict[str, list[str]]:
        service = loaded()
        assert service.adapter is not None
        return {"enabled": service.adapter.list_toolsets(name)}

    @api.put("/profiles/{name}/toolsets")
    async def put_toolsets(name: str, body: EnabledInput) -> dict[str, list[str]]:
        service = loaded()
        assert service.adapter is not None
        return {"enabled": service.adapter.set_toolsets(name, enabled=body.enabled)}

    @api.get("/projects")
    async def list_projects(profile: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.list_projects(profile)

    @api.post("/projects/validate")
    async def validate_project(body: ProjectValidationInput) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.validate_project(
            body.profile, body.project_id, body.cwd
        ).model_dump(mode="json", by_alias=True)

    @api.post("/dispatch/claim")
    async def claim_dispatch(body: ClaimInput):
        service = loaded()
        assert service.scheduler is not None
        claim = service.scheduler.claim(body.worker_id)
        if claim is None:
            return Response(status_code=204)
        return claim.model_dump(mode="json", by_alias=True)

    @api.post("/dispatch/{turn_id}/session")
    async def bind_dispatch(turn_id: str, body: SessionInput) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _turn(
            service.scheduler.bind_session(
                turn_id,
                runtime_session_id=body.runtime_session_id,
                stored_session_id=body.stored_session_id,
            )
        )

    @api.post("/dispatch/{turn_id}/events")
    async def record_dispatch_event(turn_id: str, body: GatewayEventInput) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        result = service.scheduler.record_event(turn_id, body.type, body.payload)
        return _approval(result) if isinstance(result, ApprovalRecord) else _frame(result)

    @api.post("/dispatch/{turn_id}/complete")
    async def complete_dispatch(turn_id: str, body: CompletionInput) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _turn(
            service.scheduler.complete(
                turn_id, visible_text=body.visible_text, envelope=body.envelope
            )
        )

    @api.post("/dispatch/{turn_id}/classification")
    async def complete_classification(
        turn_id: str, body: ClassificationInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        turns = service.scheduler.complete_classification(turn_id, body.raw_result)
        return {"turnIds": [turn.id for turn in turns]}

    @api.post("/turns/{turn_id}/cancel")
    async def cancel_turn(turn_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _turn(service.scheduler.cancel(turn_id))

    @api.post("/turns/{turn_id}/retry", status_code=201)
    async def retry_turn(turn_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _turn(service.scheduler.retry(turn_id))

    @api.post("/approvals/{approval_id}/resolve")
    async def resolve_approval(approval_id: str, body: ApprovalInput) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _approval(
            service.scheduler.resolve_approval(
                approval_id, decision=body.decision, note=body.note
            )
        )

    @api.get("/activity")
    @api.get("/events")
    async def get_events(after: int = 0, channel_id: str | None = None) -> list[dict[str, Any]]:
        service = loaded()
        assert service.scheduler is not None
        return [
            _frame(item)
            for item in service.scheduler.events_after(after, channel_id=channel_id)
        ]

    @api.websocket("/events")
    async def event_socket(websocket: WebSocket) -> None:
        service = loaded()
        assert service.bus is not None
        await websocket.accept()
        queue = service.bus.subscribe()
        try:
            while True:
                await websocket.send_json(_frame(await queue.get()))
        except WebSocketDisconnect:
            pass
        finally:
            service.bus.unsubscribe(queue)

    return api


router = create_router()
