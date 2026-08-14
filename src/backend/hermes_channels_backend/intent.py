"""Parsing for the Hermes Channels response envelope markers."""

import json
import re

from pydantic import ValidationError

from .models import IntentEnvelope


_MARKER = re.compile(r"(?:<!--|\[\[)\s*hermes-(?:channels|crew):intent\s+(\{.*?\})\s*(?:-->|\]\])", re.DOTALL)
_ANY_INTENT_COMMENT = re.compile(r"(?:<!--\s*hermes-(?:channels|crew):intent\b[^\r\n]*?-->|\[\[\s*hermes-(?:channels|crew):intent\b[^\r\n]*?\]\])")
# Tolerate truncated closers ("}]"): a line that opens as a marker is one.
_SLOPPY_MARKER_LINE = re.compile(r"^[ \t]*(?:<!--|\[\[)\s*hermes-(?:channels|crew):intent\b[^\r\n]*$", re.MULTILINE)
_MAX_PAYLOAD_BYTES = 4096

# Intents that schedule work, strongest first: a merged envelope keeps the
# scheduling character if any fragment had one.
_SCHEDULING_INTENTS = ("handoff", "review_request", "reply_required", "question")


def _visible_text(text: str) -> str:
    return _SLOPPY_MARKER_LINE.sub(
        "", _ANY_INTENT_COMMENT.sub("", _MARKER.sub("", text))
    ).strip()


def _merge(envelopes: list[IntentEnvelope]) -> IntentEnvelope:
    """Collapse several markers into one envelope.

    The contract asks for exactly one marker, but models routinely emit one
    per delegation plus a wrap-up "inform" — taking only the last (or
    rejecting the message outright) silently dropped every real handoff.
    Recipients union; the strongest scheduling intent wins; budgets take the
    maximum; placement takes the first explicit choice.
    """

    if len(envelopes) == 1:
        return envelopes[0]
    intent = next(
        (name for name in _SCHEDULING_INTENTS if any(e.intent == name for e in envelopes)),
        envelopes[-1].intent,
    )
    recipients: list[str] = []
    for envelope in envelopes:
        for recipient in envelope.recipients:
            if recipient not in recipients:
                recipients.append(recipient)
    placement = next((e.placement for e in envelopes if e.placement != "auto"), "auto")
    summary = next((e.summary for e in reversed(envelopes) if e.summary), "")
    correlation = next((e.correlation_id for e in envelopes if e.correlation_id), None)
    scheduling = intent in _SCHEDULING_INTENTS
    return IntentEnvelope(
        intent=intent,
        recipients=recipients,
        # A merged scheduling envelope must stay schedulable even if only
        # some fragments carried the reply fields.
        reply_expected=any(e.reply_expected for e in envelopes) or scheduling,
        reply_budget=max([e.reply_budget for e in envelopes] + ([1] if scheduling else [])),
        correlation_id=correlation,
        summary=summary,
        placement=placement,
    )


def parse_agent_output(text: str) -> tuple[str, IntentEnvelope]:
    """Return displayable prose and a safe, validated routing envelope."""

    envelopes: list[IntentEnvelope] = []
    for match in _MARKER.finditer(text):
        payload = match.group(1)
        if len(payload.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
            continue
        try:
            envelopes.append(IntentEnvelope.model_validate(json.loads(payload)))
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError):
            continue
    if not envelopes:
        return _visible_text(text), IntentEnvelope(intent="inform")
    return _visible_text(text), _merge(envelopes)
