"""Deterministic Hermes gateway used by the v0.1.0 acceptance suite."""

from dataclasses import dataclass
from typing import Any

from hermes_channels_backend.intent import parse_agent_output
from hermes_channels_backend.models import DispatchClaim, ProjectRef
from hermes_channels_backend.repositories import CrewRepository, MessageRecord
from hermes_channels_backend.scheduler import ApprovalRecord, Scheduler, TurnRecord


@dataclass(frozen=True, slots=True)
class FakeProfile:
    provider: str | None
    model: str | None


@dataclass(frozen=True, slots=True)
class FakeSession:
    turn_id: str
    runtime_session_id: str
    profile_id: str
    provider: str
    model: str
    cwd: str | None


class ReadinessError(RuntimeError):
    """Raised after a fake gateway has durably failed an invalid claim."""


class FakeHermesGateway:
    """Exercise real Crew routing/scheduling around a recorded Hermes RPC seam."""

    def __init__(
        self,
        repository: CrewRepository,
        scheduler: Scheduler,
        *,
        profiles: dict[str, FakeProfile],
        projects: set[tuple[str, str]],
    ) -> None:
        self.repository = repository
        self.scheduler = scheduler
        self.profiles = profiles
        self.projects = projects
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.sessions: dict[str, FakeSession] = {}
        self.submitted_turn_ids: list[str] = []
        self._session_number = 0

    def submit_user(
        self,
        channel_id: str,
        content: str,
        *,
        mentions: list[str] | None = None,
        root_message_id: str | None = None,
        project: ProjectRef | None = None,
        idempotency_key: str | None = None,
    ) -> tuple[MessageRecord, list[TurnRecord]]:
        message = self.repository.append_message(
            channel_id,
            "user",
            content,
            mentions=mentions,
            root_message_id=root_message_id,
            project=project,
            idempotency_key=idempotency_key,
        )
        turns = [self.scheduler.enqueue(item) for item in self.scheduler.router.plan(message.id)]
        return message, turns

    def start_next(self) -> FakeSession | None:
        claim = self.scheduler.claim("fake-desktop")
        if claim is None:
            return None
        try:
            return self._start_claim(claim)
        except ReadinessError as exc:
            self.scheduler.fail(claim.id, str(exc))
            raise

    def _start_claim(self, claim: DispatchClaim) -> FakeSession:
        if claim.kind != "agent" or claim.profile_id is None:
            raise ReadinessError("acceptance gateway expected an agent claim")
        profile = self.profiles.get(claim.profile_id)
        if profile is None:
            raise ReadinessError(f"profile {claim.profile_id} does not exist")
        if not profile.provider or not profile.model:
            raise ReadinessError(
                f"profile {claim.profile_id} has no configured model"
            )
        if claim.cwd is not None and (claim.profile_id, claim.cwd) not in self.projects:
            raise ReadinessError(
                f"project {claim.cwd} is not available to profile {claim.profile_id}"
            )

        self._session_number += 1
        runtime_id = f"runtime-{self._session_number}"
        create_params: dict[str, Any] = {
            "cols": 96,
            "source": "desktop",
            "profile": claim.profile_id,
            "fast": False,
        }
        if claim.cwd is not None:
            create_params["cwd"] = claim.cwd
        if claim.model is not None:
            create_params["model"] = claim.model
        if claim.provider is not None:
            create_params["provider"] = claim.provider
        if claim.reasoning_effort is not None:
            create_params["reasoning_effort"] = claim.reasoning_effort
        self.calls.append(("session.create", create_params))
        self.scheduler.bind_session(
            claim.id,
            runtime_session_id=runtime_id,
            stored_session_id=f"stored-{self._session_number}",
        )
        self.calls.append(
            (
                "prompt.submit",
                {"session_id": runtime_id, "text": claim.context},
            )
        )
        session = FakeSession(
            turn_id=claim.id,
            runtime_session_id=runtime_id,
            profile_id=claim.profile_id,
            provider=profile.provider,
            model=profile.model,
            cwd=claim.cwd,
        )
        self.sessions[claim.id] = session
        self.submitted_turn_ids.append(claim.id)
        return session

    def complete(self, turn_id: str, raw_text: str) -> TurnRecord:
        session = self.sessions.pop(turn_id)
        self.calls.append(
            (
                "message.complete",
                {"session_id": session.runtime_session_id, "text": raw_text},
            )
        )
        visible_text, envelope = parse_agent_output(raw_text)
        return self.scheduler.complete(
            turn_id, visible_text=visible_text, envelope=envelope
        )

    def request_approval(self, turn_id: str, request_id: str) -> ApprovalRecord:
        result = self.scheduler.record_event(
            turn_id,
            "approval_request",
            {"requestId": request_id, "prompt": "Allow this action?"},
        )
        assert isinstance(result, ApprovalRecord)
        return result

    def resolve_approval(
        self, approval_id: str, decision: str
    ) -> ApprovalRecord:
        self.calls.append(
            (
                "approval.respond",
                {"request_id": approval_id, "choice": decision},
            )
        )
        return self.scheduler.resolve_approval(
            approval_id, decision=decision, note="acceptance test"
        )


def marker(
    intent: str = "inform",
    *,
    recipients: list[str] | None = None,
    reply_expected: bool = False,
    reply_budget: int = 0,
    placement: str | None = None,
) -> str:
    targets = recipients or []
    recipients_json = ",".join(f'"{item}"' for item in targets)
    placement_json = f',"placement":"{placement}"' if placement else ""
    return (
        '<!-- hermes-channels:intent {"schemaVersion":1,'
        f'"intent":"{intent}","recipients":[{recipients_json}],' 
        f'"replyExpected":{str(reply_expected).lower()},'
        f'"replyBudget":{reply_budget}{placement_json}}} -->'
    )
