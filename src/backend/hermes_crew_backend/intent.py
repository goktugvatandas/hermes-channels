"""Parsing for the Markdown-hidden Hermes Crew response envelope."""

import json
import re

from pydantic import ValidationError

from .models import IntentEnvelope


_MARKER = re.compile(r"<!-- hermes-crew:intent (\{[^\r\n]*\}) -->")
_ANY_INTENT_COMMENT = re.compile(r"<!--\s*hermes-crew:intent\b[^\r\n]*?-->")
_MAX_PAYLOAD_BYTES = 4096


def _visible_text(text: str) -> str:
    return _ANY_INTENT_COMMENT.sub("", text).strip()


def parse_agent_output(text: str) -> tuple[str, IntentEnvelope]:
    """Return displayable prose and a safe, validated routing envelope."""

    matches = list(_MARKER.finditer(text))
    fallback = IntentEnvelope(intent="inform")
    if len(matches) != 1:
        return _visible_text(text), fallback

    match = matches[0]
    if text[match.end() :].strip():
        return _visible_text(text), fallback
    payload = match.group(1)
    if len(payload.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        return _visible_text(text), fallback

    try:
        raw = json.loads(payload)
        envelope = IntentEnvelope.model_validate(raw)
    except (json.JSONDecodeError, ValidationError, TypeError, ValueError):
        return _visible_text(text), fallback
    return _visible_text(text), envelope
