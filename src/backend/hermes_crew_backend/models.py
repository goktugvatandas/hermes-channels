"""Validated domain models shared across Crew backend boundaries."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ActivationPolicy = Literal["always", "mentioned", "observer", "disabled"]
MessageIntent = Literal[
    "inform",
    "result",
    "reply_required",
    "question",
    "handoff",
    "review_request",
    "blocked",
    "approval_request",
]
DispatchKind = Literal["agent", "classification"]


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


def _validate_uuid4_hex(value: str) -> str:
    try:
        parsed = UUID(value)
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("must be a lowercase UUID4 hex string") from exc
    if parsed.version != 4 or parsed.hex != value:
        raise ValueError("must be a lowercase UUID4 hex string")
    return value


class WireModel(BaseModel):
    """Base model supporting Crew's camelCase JSON wire representation."""

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class ProjectRef(WireModel):
    mode: Literal["inherit", "global", "project"]
    profile: str | None = None
    project_id: str | None = None
    label: str | None = None
    cwd: str | None = None

    @model_validator(mode="after")
    def validate_project(self) -> "ProjectRef":
        if self.mode == "project" and not (
            self.profile and self.project_id and self.cwd
        ):
            raise ValueError("project mode requires profile, project_id, and cwd")
        return self


class IntentEnvelope(WireModel):
    schema_version: Literal[1] = 1
    intent: MessageIntent = "inform"
    recipients: list[str] = Field(default_factory=list)
    reply_expected: bool = False
    reply_budget: int = Field(default=0, ge=0, le=2)
    correlation_id: str | None = None
    summary: str = Field(default="", max_length=500)
    # Where the answer lands: auto follows the trigger (channel-level question
    # gets a channel-level answer, thread question stays threaded); thread
    # always threads under the trigger; channel always posts to the timeline.
    placement: Literal["auto", "thread", "channel"] = "auto"

    @field_validator("recipients")
    @classmethod
    def validate_recipients(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("recipients must contain non-empty profile ids")
        if len(set(cleaned)) != len(cleaned):
            raise ValueError("recipients must be unique")
        return cleaned

    @model_validator(mode="after")
    def validate_reply(self) -> "IntentEnvelope":
        reply_intents = {"reply_required", "handoff", "review_request", "question"}
        if self.intent in reply_intents and not self.recipients:
            raise ValueError("reply-bearing intents require recipients")
        if self.intent in reply_intents and not self.reply_expected:
            raise ValueError("reply-bearing intents require reply_expected")
        return self


class DispatchClaim(WireModel):
    """Durable work item transferred from the backend to a Desktop worker."""

    id: str
    kind: DispatchKind
    channel_id: str
    profile_id: str | None = None
    context: str = ""
    instructions: str | None = None
    input: str | None = None
    cwd: str | None = None
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    max_tokens: int = Field(default=300, ge=1)
    temperature: float = Field(default=0, ge=0, le=2)
    created_at: int = Field(ge=0)

    @field_validator("id", "channel_id")
    @classmethod
    def validate_ids(cls, value: str) -> str:
        return _validate_uuid4_hex(value)

    @model_validator(mode="after")
    def validate_kind_payload(self) -> "DispatchClaim":
        if self.kind == "agent" and not (self.profile_id and self.context):
            raise ValueError("agent claims require profile_id and context")
        if self.kind == "classification" and not (
            self.instructions is not None and self.input is not None
        ):
            raise ValueError("classification claims require instructions and input")
        return self
