"""Scoped FastAPI routes mounted by Hermes at /api/plugins/hermes-channels."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from functools import partial
import logging
import os
from pathlib import Path
import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .avatar_generation import (
    avatar_prompt,
    enhance_user_prompt,
    to_avatar_data_url,
    user_avatar_prompt,
)
from .classifier import Classifier
from .card_references import CardReferenceStore
from .db import CrewDatabase
from .event_bus import EventBus, EventFrame
from .hermes_adapter import HermesAdapter
from .kanban_bridge import BOARD_MAP_SETTING, KanbanBridge, default_board_slug
from .models import ActivationPolicy, IntentEnvelope, ProjectRef
from .repositories import (
    ChannelMemberRecord,
    ChannelRecord,
    CrewRepository,
    MemberPresentationRecord,
    MessageRecord,
)
from .routing import Router
from .profile_enablement import ensure_profiles_enabled
from .session_visibility import backfill_archive
from .scheduler import ApprovalRecord, Scheduler, TurnRecord


logger = logging.getLogger("hermes_channels")


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


class ChannelSectionInput(ApiModel):
    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1, max_length=40)


class ChannelSectionsPayload(ApiModel):
    sections: list[ChannelSectionInput] = Field(default_factory=list, max_length=32)
    # channelId -> sectionId; unassigned channels render under the root group.
    assignments: dict[str, str] = Field(default_factory=dict)


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


class ChannelMemberInput(ApiModel):
    activation_policy: ActivationPolicy


# Avatars must be small self-contained data URLs: remote URLs would turn every
# roster render into a tracking beacon, and unbounded strings bloat channels.db
# and every /members response. ~400k chars ≈ a 300 KB image.
_AVATAR_MAX_CHARS = 400_000


def _validate_avatar(value: str | None) -> str | None:
    if value is None or value == "":
        return value
    if not value.startswith("data:image/"):
        raise ValueError("avatar must be a data:image/... URL")
    return value


class MemberPatch(ApiModel):
    display_name: str | None = Field(default=None, max_length=120)
    role: str | None = Field(default=None, max_length=200)
    avatar: str | None = Field(default=None, max_length=_AVATAR_MAX_CHARS)
    color: str | None = Field(default=None, max_length=32)
    model_label: str | None = Field(default=None, max_length=200)
    default_project: ProjectRef | None = None
    archived: bool | None = None

    @field_validator("avatar")
    @classmethod
    def _avatar_scheme(cls, value: str | None) -> str | None:
        return _validate_avatar(value)


class RoutingDefaultsPatch(ApiModel):
    max_automated_turns: int | None = Field(default=None, ge=0, le=200)
    max_depth: int | None = Field(default=None, ge=0, le=50)
    max_pair_repeats: int | None = Field(default=None, ge=0, le=50)
    max_concurrency: int | None = Field(default=None, ge=1, le=64)


class CardPrefixPatch(ApiModel):
    prefix: str | None = Field(default=None, max_length=8)


class UserIdentityPatch(ApiModel):
    display_name: str | None = Field(default=None, max_length=120)
    avatar: str | None = Field(default=None, max_length=_AVATAR_MAX_CHARS)
    color: str | None = Field(default=None, max_length=32)

    @field_validator("avatar")
    @classmethod
    def _avatar_scheme(cls, value: str | None) -> str | None:
        return _validate_avatar(value)


class AvatarGenerateInput(ApiModel):
    model: str | None = Field(default=None, max_length=200)
    prompt: str | None = Field(default=None, max_length=2000)


class ClassifierInput(ApiModel):
    enabled: bool = False
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    max_tokens: int = Field(default=300, ge=1, le=4096)
    confidence_threshold: float = Field(default=0.65, ge=0, le=1)


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


class DispatchFailureInput(ApiModel):
    error: str = Field(min_length=1, max_length=500)


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


class OnboardingInput(ApiModel):
    default_responder_profile: str = Field(min_length=1)
    profiles: list[str] = Field(min_length=1)


class KanbanCardCreate(ApiModel):
    title: str = Field(min_length=1, max_length=500)
    body: str | None = Field(default=None, max_length=20_000)
    assignee: str | None = None
    priority: int = Field(default=0, ge=-10, le=10)
    triage: bool = False
    idempotency_key: str | None = None


class KanbanCompleteInput(ApiModel):
    result: str | None = Field(default=None, max_length=20_000)


class KanbanBlockInput(ApiModel):
    reason: str | None = Field(default=None, max_length=2000)


class KanbanCommentInput(ApiModel):
    body: str = Field(min_length=1, max_length=20_000)


class KanbanBoardInput(ApiModel):
    board_slug: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9][a-z0-9-]*$")


class KanbanAssignInput(ApiModel):
    assignee: str | None = None


class KanbanCardPatch(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    body: str | None = Field(default=None, max_length=20_000)
    priority: int | None = Field(default=None, ge=-10, le=10)


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
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001 - route safety net
                # A bare 500 reaches the UI as "Internal Server Error" with no
                # clue; surface the exception type and message so the save
                # inspector shows something actionable.
                logger.exception("Unhandled error in Crew route")
                return _error(500, "internal_error", f"{type(exc).__name__}: {exc}")

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
    kanban: KanbanBridge | None = None

    def load(self) -> "BackendServices":
        if self.database is None:
            self.database = CrewDatabase(self.database_path)
            self.repository = CrewRepository(self.database)
            self.bus = EventBus()
            self.scheduler = Scheduler(self.repository, event_bus=self.bus)
            self.scheduler.reconcile_startup(set())
            backfill_archive(self.repository)
            ensure_profiles_enabled()
        if self.adapter is None:
            self.adapter = HermesAdapter()
        if self.kanban is None:
            assert self.database is not None
            self.kanban = KanbanBridge(references=CardReferenceStore(self.database))
        return self


def _default_database_path() -> Path:
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return hermes_home / "channels" / "channels.db"


async def _blocking_call(function, /, *args, **kwargs):
    """Run a blocking host SDK call without FastAPI's implicit AnyIO pool."""

    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="channels-sdk") as executor:
        return await loop.run_in_executor(executor, partial(function, *args, **kwargs))


def _resolve_session_store(
    database_path: Path, database: CrewDatabase, session_id: str
) -> tuple[Path, str]:
    """Map either turn session id to the owning Hermes profile store."""

    stored_session_id = session_id
    profile_id: str | None = None
    with database.connect() as connection:
        turn = connection.execute(
            """SELECT profile_id, stored_session_id FROM turns
               WHERE stored_session_id = ? OR runtime_session_id = ?
               ORDER BY created_at DESC LIMIT 1""",
            (session_id, session_id),
        ).fetchone()
    if turn is not None:
        profile_id = turn["profile_id"]
        stored_session_id = turn["stored_session_id"] or session_id
    home = database_path.parent.parent
    state_db = (
        home / "profiles" / profile_id / "state.db"
        if profile_id and profile_id != "default"
        else home / "state.db"
    )
    return state_db, stored_session_id


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


def _member(record: MemberPresentationRecord) -> dict[str, Any]:
    return {
        "profileId": record.profile_id,
        "displayName": record.display_name,
        "role": record.role,
        "avatar": record.avatar,
        "color": record.color,
        "modelLabel": record.model_label,
        "defaultProject": record.default_project.model_dump(by_alias=True)
        if record.default_project
        else None,
        "archived": record.archived,
        "updatedAt": record.updated_at,
    }


def _channel_member(record: ChannelMemberRecord) -> dict[str, Any]:
    return {
        "channelId": record.channel_id,
        "profileId": record.profile_id,
        "activationPolicy": record.activation_policy,
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
    kanban_bridge: KanbanBridge | None = None,
) -> APIRouter:
    services = BackendServices(
        Path(database_path or _default_database_path()),
        adapter=hermes_adapter,
        kanban=kanban_bridge,
    )
    api = APIRouter(route_class=CrewRoute)

    def loaded() -> BackendServices:
        return services.load()

    @api.get("/health")
    async def health() -> dict[str, Any]:
        loaded()
        return {"ok": True, "service": "hermes-channels"}

    @api.post("/onboarding")
    async def onboarding(body: OnboardingInput) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        return _channel(
            service.repository.onboard(
                body.default_responder_profile, body.profiles
            )
        )

    @api.get("/channels")
    async def list_channels() -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        return [_channel(item) for item in service.repository.list_channels()]

    @api.post("/channels", status_code=201)
    async def create_channel(body: ChannelCreate) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        if body.default_responder_profile:
            responder = next(
                (
                    member
                    for member in body.members
                    if member.profile_id == body.default_responder_profile
                ),
                None,
            )
            if responder is None or responder.activation_policy in {"observer", "disabled"}:
                raise HTTPException(
                    status_code=422,
                    detail="default responder must be an active channel member",
                )
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
        responder = changes.get("default_responder_profile")
        if responder:
            membership = next(
                (
                    member
                    for member in service.repository.list_members(channel_id)
                    if member.profile_id == responder
                ),
                None,
            )
            if membership is None or membership.activation_policy in {"observer", "disabled"}:
                raise HTTPException(
                    status_code=409,
                    detail="default responder must be an active channel member",
                )
        return _channel(service.repository.update_channel(channel_id, **changes))

    @api.get("/channels/{channel_id}/members")
    async def list_channel_members(channel_id: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        service.repository.require_channel(channel_id)
        return [_channel_member(item) for item in service.repository.list_members(channel_id)]

    @api.put("/channels/{channel_id}/members/{profile_id}")
    async def put_channel_member(
        channel_id: str, profile_id: str, body: ChannelMemberInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        channel = service.repository.require_channel(channel_id)
        if (
            channel.default_responder_profile == profile_id
            and body.activation_policy in {"observer", "disabled"}
        ):
            raise HTTPException(
                status_code=409,
                detail="the default responder must remain active — pick a new "
                "default responder for the channel first",
            )
        return _channel_member(
            service.repository.add_member(
                channel_id, profile_id, activation_policy=body.activation_policy
            )
        )

    @api.delete("/channels/{channel_id}/members/{profile_id}")
    async def delete_channel_member(channel_id: str, profile_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        channel = service.repository.require_channel(channel_id)
        if channel.default_responder_profile == profile_id:
            raise HTTPException(
                status_code=409,
                detail="the default responder cannot be removed — pick a new "
                "default responder for the channel first",
            )
        removed = service.repository.remove_member(channel_id, profile_id)
        if not removed:
            raise HTTPException(status_code=404, detail="not a channel member")
        return {"ok": True}

    @api.get("/members")
    async def list_all_members() -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        return [_member(item) for item in service.repository.list_member_presentations()]

    @api.get("/me")
    async def get_user_identity() -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        stored = service.repository.get_setting("user_identity") or {}
        return {
            "displayName": stored.get("displayName") or "You",
            "avatar": stored.get("avatar"),
            "color": stored.get("color"),
        }

    @api.patch("/me")
    async def patch_user_identity(body: UserIdentityPatch) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        stored = service.repository.get_setting("user_identity") or {}
        changes = body.model_dump(exclude_unset=True, by_alias=True)
        stored.update(changes)
        service.repository.set_setting("user_identity", stored)
        return {
            "displayName": stored.get("displayName") or "You",
            "avatar": stored.get("avatar"),
            "color": stored.get("color"),
        }

    @api.get("/image-generation")
    async def image_generation_status() -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        return service.adapter.image_generation_status()

    @api.post("/members/{profile_id}/avatar/generate")
    async def generate_member_avatar(
        profile_id: str, body: AvatarGenerateInput | None = None
    ) -> Any:
        service = loaded()
        assert service.repository is not None
        assert service.adapter is not None
        member = service.repository.get_member_presentation(profile_id)
        options = body or AvatarGenerateInput()
        if options.prompt and options.prompt.strip():
            prompt = enhance_user_prompt(options.prompt)
        else:
            description = ""
            soul = ""
            try:
                description = service.adapter.get_profile(profile_id).get("description") or ""
            except Exception:
                pass
            try:
                soul = service.adapter.read_soul(profile_id)
            except Exception:
                pass
            prompt = avatar_prompt(
                member.display_name or profile_id, member.role, description, soul[:300]
            )
        result = await _blocking_call(
            service.adapter.generate_image,
            prompt,
            aspect_ratio="square",
            model=options.model,
        )
        if not result.get("success") or not result.get("image"):
            return _error(
                502, "generation_failed", str(result.get("error") or "image generation failed")
            )
        avatar = to_avatar_data_url(str(result["image"]))
        return _member(
            service.repository.update_member_presentation(profile_id, avatar=avatar)
        )

    @api.post("/me/avatar/generate")
    async def generate_user_avatar(body: AvatarGenerateInput | None = None) -> Any:
        service = loaded()
        assert service.repository is not None
        assert service.adapter is not None
        options = body or AvatarGenerateInput()
        stored = service.repository.get_setting("user_identity") or {}
        if options.prompt and options.prompt.strip():
            prompt = enhance_user_prompt(options.prompt)
        else:
            prompt = user_avatar_prompt(str(stored.get("displayName") or "You"))
        result = await _blocking_call(
            service.adapter.generate_image,
            prompt,
            aspect_ratio="square",
            model=options.model,
        )
        if not result.get("success") or not result.get("image"):
            return _error(
                502, "generation_failed", str(result.get("error") or "image generation failed")
            )
        # Re-read before writing: generation blocks for up to minutes, and
        # writing the pre-generation snapshot back would silently revert any
        # rename/color change made meanwhile.
        stored = service.repository.get_setting("user_identity") or {}
        stored["avatar"] = to_avatar_data_url(str(result["image"]))
        service.repository.set_setting("user_identity", stored)
        return {
            "displayName": stored.get("displayName") or "You",
            "avatar": stored.get("avatar"),
            "color": stored.get("color"),
        }

    @api.get("/members/{profile_id}")
    async def get_member(profile_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        return _member(service.repository.get_member_presentation(profile_id))

    @api.patch("/members/{profile_id}")
    async def patch_member(profile_id: str, body: MemberPatch) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        # Only these columns are nullable; an explicit null elsewhere would
        # surface as a 500/409 from the NOT NULL constraints.
        clearable = {"avatar", "color", "model_label", "default_project"}
        changes = {
            key: value
            for key, value in body.model_dump(exclude_unset=True).items()
            if value is not None or key in clearable
        }
        return _member(
            service.repository.update_member_presentation(profile_id, **changes)
        )

    @api.get("/channels/{channel_id}/classifier")
    async def get_classifier(channel_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        service.repository.require_channel(channel_id)
        with service.repository.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM classifier_configs WHERE channel_id = ?", (channel_id,)
            ).fetchone()
        if row is None:
            return {
                "enabled": False,
                "provider": None,
                "model": None,
                "reasoningEffort": None,
                "maxTokens": 300,
                "confidenceThreshold": 0.65,
            }
        return {
            "enabled": bool(row["enabled"]),
            "provider": row["provider"],
            "model": row["model"],
            "reasoningEffort": row["reasoning_effort"],
            "maxTokens": row["max_tokens"],
            "confidenceThreshold": row["confidence_threshold"],
        }

    @api.put("/channels/{channel_id}/classifier")
    async def put_classifier(channel_id: str, body: ClassifierInput) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        Classifier(service.repository).configure(
            channel_id,
            enabled=body.enabled,
            provider=body.provider,
            model=body.model,
            reasoning_effort=body.reasoning_effort,
            max_tokens=body.max_tokens,
            confidence_threshold=body.confidence_threshold,
        )
        return await get_classifier(channel_id)

    def _resolve_board(service: BackendServices, channel_id: str) -> str | None:
        """The channel's board slug, or None when nothing is bound yet.

        An explicit binding always wins (and is ensured on disk — the user
        chose it). The conventional ``channel-<name>`` board is only adopted
        when it already exists: users with active boards of their own connect
        those instead of having a board silently created for every channel.
        """

        assert service.repository is not None and service.kanban is not None
        channel = service.repository.require_channel(channel_id)
        overrides = service.repository.get_setting(BOARD_MAP_SETTING) or {}
        try:
            bound = overrides.get(channel.id)
            if bound:
                service.kanban.ensure_board(bound, display_name=f"#{channel.name}")
                return bound
            conventional = default_board_slug(channel.name)
            return conventional if service.kanban.board_exists(conventional) else None
        except ModuleNotFoundError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"host kanban store unavailable: {exc}",
            ) from exc

    def _channel_board(service: BackendServices, channel_id: str) -> str:
        slug = _resolve_board(service, channel_id)
        if slug is None:
            raise HTTPException(
                status_code=409,
                detail="this channel has no kanban board yet — create or connect one first",
            )
        return slug

    @api.get("/channels/{channel_id}/kanban")
    async def get_channel_kanban(channel_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None and service.kanban is not None
        channel = service.repository.require_channel(channel_id)
        slug = _resolve_board(service, channel_id)
        if slug is None:
            return {
                "bound": False,
                "suggestedSlug": default_board_slug(channel.name),
                "boards": service.kanban.list_boards(),
            }
        return {"bound": True, **service.kanban.snapshot(slug)}

    @api.get("/channels/{channel_id}/kanban/boards")
    async def list_kanban_boards(channel_id: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None and service.kanban is not None
        service.repository.require_channel(channel_id)
        return service.kanban.list_boards()

    @api.put("/channels/{channel_id}/kanban/board")
    async def put_channel_kanban_board(
        channel_id: str, body: KanbanBoardInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None and service.kanban is not None
        channel = service.repository.require_channel(channel_id)
        overrides = service.repository.get_setting(BOARD_MAP_SETTING) or {}
        if body.board_slug == default_board_slug(channel.name):
            overrides.pop(channel.id, None)
            # Binding the conventional slug is the explicit "create my board"
            # action, so materialize it.
            service.kanban.ensure_board(body.board_slug, display_name=f"#{channel.name}")
        else:
            overrides[channel.id] = body.board_slug
        service.repository.set_setting(BOARD_MAP_SETTING, overrides)
        return {"bound": True, **service.kanban.snapshot(_channel_board(service, channel_id))}

    @api.post("/channels/{channel_id}/kanban/cards", status_code=201)
    async def create_channel_card(
        channel_id: str, body: KanbanCardCreate
    ) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.create_card(
            _channel_board(service, channel_id),
            title=body.title,
            body=body.body,
            assignee=body.assignee,
            priority=body.priority,
            triage=body.triage,
            created_by="channels",
            idempotency_key=body.idempotency_key,
        )

    @api.get("/channels/{channel_id}/kanban/cards/{task_id}")
    async def get_channel_card(channel_id: str, task_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.get_card(_channel_board(service, channel_id), task_id)

    @api.post("/channels/{channel_id}/kanban/cards/{task_id}/complete")
    async def complete_channel_card(
        channel_id: str, task_id: str, body: KanbanCompleteInput | None = None
    ) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.complete_card(
            _channel_board(service, channel_id),
            task_id,
            result=(body.result if body else None),
        )

    @api.post("/channels/{channel_id}/kanban/cards/{task_id}/block")
    async def block_channel_card(
        channel_id: str, task_id: str, body: KanbanBlockInput | None = None
    ) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.block_card(
            _channel_board(service, channel_id),
            task_id,
            reason=(body.reason if body else None),
        )

    @api.post("/channels/{channel_id}/kanban/open")
    async def open_channel_kanban(channel_id: str) -> dict[str, Any]:
        """Switch the host's current board to this channel's board so the
        official Kanban page (which renders the current board) shows it."""

        service = loaded()
        assert service.kanban is not None
        slug = _channel_board(service, channel_id)
        service.kanban.switch_current_board(slug)
        return {"boardSlug": slug}

    @api.patch("/channels/{channel_id}/kanban/cards/{task_id}")
    async def edit_channel_card(
        channel_id: str, task_id: str, body: KanbanCardPatch
    ) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        changes = body.model_dump(exclude_unset=True)
        return service.kanban.edit_card(
            _channel_board(service, channel_id), task_id, **changes
        )

    @api.post("/channels/{channel_id}/kanban/cards/{task_id}/assign")
    async def assign_channel_card(
        channel_id: str, task_id: str, body: KanbanAssignInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.assign_card(
            _channel_board(service, channel_id), task_id, body.assignee
        )

    @api.post("/channels/{channel_id}/kanban/cards/{task_id}/unblock")
    async def unblock_channel_card(channel_id: str, task_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        return service.kanban.unblock_card(_channel_board(service, channel_id), task_id)

    @api.post("/channels/{channel_id}/kanban/cards/{task_id}/comments", status_code=201)
    async def comment_channel_card(
        channel_id: str, task_id: str, body: KanbanCommentInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None and service.kanban is not None
        identity = service.repository.get_setting("user_identity") or {}
        author = str(identity.get("displayName") or "You")
        return service.kanban.comment_card(
            _channel_board(service, channel_id), task_id, author=author, body=body.body
        )

    @api.delete("/channels/{channel_id}/kanban/cards/{task_id}")
    async def delete_channel_card(channel_id: str, task_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.kanban is not None
        service.kanban.delete_card(_channel_board(service, channel_id), task_id)
        return {"ok": True}

    @api.get("/channels/{channel_id}/messages")
    async def list_messages(channel_id: str) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        service.repository.require_channel(channel_id)
        return [
            _message(item)
            for item in service.repository.list_channel_messages(channel_id, limit=500)
        ]

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

    @api.get("/sessions/{session_id}/transcript")
    async def session_transcript(session_id: str) -> dict[str, Any]:
        """Stored Hermes session transcript for the in-Crew session console.

        Reads the agent's session store (state.db in the owner HERMES_HOME,
        derived from the crew database location) read-only. Declared sync so
        FastAPI runs the blocking sqlite read in its threadpool. The store
        belongs to Hermes, not Crew — tolerate schema drift and locking by
        answering 404 rather than surfacing raw sqlite errors.
        """
        service = loaded()
        assert service.database is not None
        state_db, stored_session_id = _resolve_session_store(
            service.database_path, service.database, session_id
        )
        if not state_db.is_file():
            raise KeyError(f"session store unavailable for: {session_id}")
        try:
            connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
        except sqlite3.Error as exc:
            raise KeyError(f"session store unreadable: {exc}") from exc
        connection.row_factory = sqlite3.Row
        try:
            session = connection.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (stored_session_id,),
            ).fetchone()
            if session is None:
                raise KeyError(f"unknown session: {session_id}")
            rows = connection.execute(
                """SELECT role, content, timestamp FROM messages
                   WHERE session_id = ? AND role IN ('user', 'assistant')
                     AND content IS NOT NULL AND content != ''
                   ORDER BY id""",
                (stored_session_id,),
            ).fetchall()
        except sqlite3.Error as exc:
            raise KeyError(f"session store unreadable: {exc}") from exc
        finally:
            connection.close()
        keys = set(session.keys())
        title = (session["title"] if "title" in keys else None) or (
            session["display_name"] if "display_name" in keys else None
        )
        return {
            "id": session["id"],
            "title": title or session["id"],
            "model": session["model"] if "model" in keys else None,
            "messages": [
                {
                    "role": row["role"],
                    "content": row["content"],
                    "createdAt": int(float(row["timestamp"]) * 1000),
                }
                for row in rows
            ],
        }

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
        profiles = service.adapter.list_profiles()
        # A bot created via Bot Mode or the CLI needs the plugin enabled in
        # its own profile config before its backend can serve Channels.
        ensure_profiles_enabled([p["name"] for p in profiles if p.get("name")])
        return profiles

    @api.post("/profiles", status_code=201)
    async def create_profile(body: ProfileCreate) -> dict[str, Any]:
        service = loaded()
        assert service.adapter is not None
        created = service.adapter.create_profile(
            body.name,
            no_skills=body.no_skills,
            clone_from=body.clone_from,
            clone_config=body.clone_config,
            clone_all=body.clone_all,
            description=body.description,
        )
        ensure_profiles_enabled([body.name])
        return created

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

    @api.get("/channel-sections")
    async def get_channel_sections() -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        stored = service.repository.get_setting("channel_sections") or {}
        payload = ChannelSectionsPayload.model_validate(stored) if stored else ChannelSectionsPayload()
        return payload.model_dump(mode="json", by_alias=True)

    @api.put("/channel-sections")
    async def put_channel_sections(body: ChannelSectionsPayload) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        known = {section.id for section in body.sections}
        if len(known) != len(body.sections):
            raise HTTPException(status_code=422, detail="duplicate section ids")
        cleaned = {
            channel_id: section_id
            for channel_id, section_id in body.assignments.items()
            if section_id in known
        }
        document = ChannelSectionsPayload(sections=body.sections, assignments=cleaned)
        service.repository.set_setting(
            "channel_sections", document.model_dump(mode="json", by_alias=True)
        )
        return document.model_dump(mode="json", by_alias=True)

    @api.get("/card-prefixes")
    async def get_card_prefixes() -> list[dict[str, Any]]:
        service = loaded()
        assert service.database is not None and service.kanban is not None
        store = CardReferenceStore(service.database)
        boards = sorted(service.kanban.list_boards(), key=lambda item: str(item["slug"]))
        result = []
        for board in boards:
            slug = str(board["slug"])
            try:
                # Snapshotting materializes references for pre-existing host cards,
                # so Settings reports and migrates the real card count immediately.
                service.kanban.snapshot(slug)
            except Exception as exc:  # one damaged board must not hide all settings
                logger.warning("Could not materialize card references for %s: %s", slug, exc)
            result.append(
                {
                    **store.configuration(slug),
                    "boardName": str(board.get("name") or slug),
                }
            )
        return result

    @api.put("/card-prefixes/{board_slug}")
    async def put_card_prefix(board_slug: str, body: CardPrefixPatch) -> dict[str, Any]:
        service = loaded()
        assert service.database is not None and service.kanban is not None
        boards = {str(board["slug"]): board for board in service.kanban.list_boards()}
        if board_slug not in boards:
            raise HTTPException(status_code=404, detail="unknown kanban board")
        store = CardReferenceStore(service.database)
        try:
            result = store.configure_prefix(board_slug, body.prefix)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            **result,
            "boardName": str(boards[board_slug].get("name") or board_slug),
        }

    @api.get("/routing-defaults")
    async def get_routing_defaults() -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None and service.scheduler is not None
        stored = service.repository.get_setting("routing_defaults") or {}
        from .routing import DEFAULT_RULES
        return {**DEFAULT_RULES, **{k: v for k, v in stored.items() if k in DEFAULT_RULES}}

    @api.put("/routing-defaults")
    async def put_routing_defaults(body: RoutingDefaultsPatch) -> dict[str, Any]:
        service = loaded()
        assert service.repository is not None
        stored = service.repository.get_setting("routing_defaults") or {}
        for key, value in body.model_dump(exclude_unset=True).items():
            if value is not None:
                stored[key] = value
        service.repository.set_setting("routing_defaults", stored)
        from .routing import DEFAULT_RULES
        return {**DEFAULT_RULES, **{k: v for k, v in stored.items() if k in DEFAULT_RULES}}

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

    @api.post("/dispatch/{turn_id}/fail")
    async def fail_dispatch(
        turn_id: str, body: DispatchFailureInput
    ) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return _turn(service.scheduler.fail(turn_id, body.error))

    @api.post("/turns/{turn_id}/heartbeat")
    async def heartbeat_turn(turn_id: str) -> dict[str, Any]:
        service = loaded()
        assert service.scheduler is not None
        return {"alive": service.scheduler.heartbeat(turn_id)}

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
    async def get_events(
        after: int = 0, channel_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        service = loaded()
        assert service.scheduler is not None
        return [
            _frame(item)
            for item in service.scheduler.events_after(
                after, channel_id=channel_id, limit=limit
            )
        ]

    @api.get("/search")
    async def search(
        q: str = "",
        channel_id: str | None = None,
        member: str | None = None,
        project: str | None = None,
        state: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        service = loaded()
        assert service.repository is not None
        return [
            {
                "kind": item.kind,
                "sourceId": item.source_id,
                "channelId": item.channel_id,
                "memberId": item.member_id,
                "projectId": item.project_id,
                "state": item.state,
                "text": item.text,
                "createdAt": item.created_at,
            }
            for item in service.repository.search(
                query=q,
                channel_id=channel_id,
                member=member,
                project=project,
                state=state,
                limit=limit,
            )
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
