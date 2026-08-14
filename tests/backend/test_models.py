import pytest
from pydantic import ValidationError

from hermes_channels_backend.models import DispatchClaim, IntentEnvelope, ProjectRef


def test_reply_bearing_intent_requires_named_recipients():
    """A missing recipient must not allow an automated review turn."""
    with pytest.raises(ValidationError, match="recipients"):
        IntentEnvelope(intent="review_request", recipients=[], reply_expected=True)


def test_reply_bearing_intent_requires_reply_expected():
    """A named handoff must explicitly opt in to another automated reply."""
    with pytest.raises(ValidationError, match="reply_expected"):
        IntentEnvelope(intent="handoff", recipients=["atlas"], reply_expected=False)


def test_project_mode_requires_a_complete_stable_reference():
    """A partial project reference must never resolve to an ambiguous cwd."""
    with pytest.raises(ValidationError, match="profile, project_id, and cwd"):
        ProjectRef(mode="project", profile="atlas", project_id="web")


def test_dispatch_claim_rejects_a_non_uuid_identifier():
    """Malformed turn ids must not cross the backend-to-worker boundary."""
    with pytest.raises(ValidationError, match="id"):
        DispatchClaim(
            id="turn-1",
            kind="agent",
            channel_id="bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb",
            profile_id="atlas",
            context="Do the work",
            created_at=1,
        )
