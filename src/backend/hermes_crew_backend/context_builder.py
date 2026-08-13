"""Deterministic, bounded prompts for Crew turns and optional classification."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .project_context import resolve_project_context
from .repositories import CrewRepository, MessageRecord

if TYPE_CHECKING:
    from .routing import PlannedTurn


MAX_RECENT_MESSAGES = 30
MAX_THREAD_MESSAGES = 100
MAX_MESSAGE_CHARS = 12_000
MAX_CONTEXT_CHARS = 120_000

RESPONSE_CONTRACT = """End your final response with exactly one marker line and no text after it:
[[hermes-crew:intent {"schemaVersion":1,"intent":"inform","recipients":[],"replyExpected":false,"replyBudget":0,"correlationId":null,"summary":"","placement":"auto"}]]
Write the marker as plain text exactly as shown (double square brackets, not an HTML comment); readers never see it — Crew strips it from the displayed message.
Use inform or result when no reply is needed. Name recipients only when a reply, handoff, or review is required.
placement controls where your answer appears: "auto" answers where you were asked, "thread" keeps or starts a thread under the triggering message (use for long work logs or side discussions), "channel" posts to the channel timeline (use for final results the whole crew should see).
If a skill named crew-collaboration is available, consult it for the full collaboration guide."""

_HIDDEN_INTENT = re.compile(r"(?:<!--\s*hermes-crew:intent\b[^\r\n]*?-->|\[\[\s*hermes-crew:intent\b[^\r\n]*?\]\])")


def _bounded_content(content: str) -> str:
    visible = _HIDDEN_INTENT.sub("", content)
    return visible[:MAX_MESSAGE_CHARS]


def _format_message(message: MessageRecord) -> str:
    author = message.author_profile_id or message.author_type
    return f"[{message.created_at}] {author}: {_bounded_content(message.content)}"


class ContextBuilder:
    def __init__(self, repository: CrewRepository):
        self.repository = repository

    def for_turn(self, turn: PlannedTurn) -> str:
        message = self.repository.require_message(turn.message_id)
        channel = self.repository.require_channel(turn.channel_id)
        project = resolve_project_context(
            self.repository,
            turn.channel_id,
            turn.message_id,
            target_profile=turn.profile_id,
        )
        members = self.repository.list_members(turn.channel_id)

        root_id = message.root_message_id or message.id
        if message.root_message_id:
            thread = self.repository.get_thread(root_id)[-MAX_THREAD_MESSAGES:]
        else:
            thread = [message]
        excluded_ids = {item.id for item in thread}
        recent = [
            item
            for item in self.repository.list_messages(turn.channel_id)
            if item.id not in excluded_ids
        ][-MAX_RECENT_MESSAGES:]

        incoming_intent = "human"
        correlation_id = None
        if message.intent_envelope:
            incoming_intent = str(message.intent_envelope.get("intent", "inform"))
            correlation_id = message.intent_envelope.get(
                "correlationId", message.intent_envelope.get("correlation_id")
            )
        # Budget accounting matches the router: automated turns are counted
        # across the causal tree from the originating human message, not by
        # thread containment (reply placement can put answers anywhere).
        origin = self.repository.causal_origin(message.id)
        automated_count = self.repository.causal_tree_agent_count(origin)

        fixed_sections = [
            (
                "CHANNEL",
                f"name: #{channel.name}\npurpose: {channel.purpose or '(none)'}\n"
                f"topic: {channel.topic or '(none)'}",
            ),
            (
                "PARTICIPANTS",
                "\n".join(
                    f"- {member.profile_id} ({member.activation_policy})"
                    for member in members
                )
                or "(none)",
            ),
            (
                "PROJECT",
                "\n".join(
                    (
                        f"mode: {project.mode}",
                        f"profile: {project.profile or '(none)'}",
                        f"project_id: {project.project_id or '(none)'}",
                        f"label: {project.label or '(none)'}",
                        f"cwd: {project.cwd or '(global)'}",
                    )
                ),
            ),
            (
                "TRIGGER",
                f"target_profile: {turn.profile_id}\n"
                f"reasons: {', '.join(turn.triggers)}\n"
                f"incoming_intent: {incoming_intent}\n"
                f"correlation_id: {correlation_id or '(none)'}\n"
                f"message: {_format_message(message)}",
            ),
            (
                "BUDGET",
                f"remaining_depth: {max(0, turn.rule_snapshot['max_depth'] - turn.depth)}\n"
                f"remaining_automated_turns: "
                f"{max(0, turn.rule_snapshot['max_automated_turns'] - automated_count)}\n"
                f"pair_repeat_limit: {turn.rule_snapshot['max_pair_repeats']}\n"
                f"channel_concurrency_limit: {turn.rule_snapshot['max_concurrency']}",
            ),
        ]

        def assemble(
            recent_messages: list[MessageRecord], thread_messages: list[MessageRecord]
        ) -> str:
            sections = fixed_sections[:4]
            sections.extend(
                [
                    (
                        "THREAD",
                        "\n".join(_format_message(item) for item in thread_messages)
                        or "(none)",
                    ),
                    (
                        "RECENT CHANNEL",
                        "\n".join(_format_message(item) for item in recent_messages)
                        or "(none)",
                    ),
                    fixed_sections[4],
                    ("RESPONSE CONTRACT", RESPONSE_CONTRACT),
                ]
            )
            return "\n\n".join(f"## {heading}\n{body}" for heading, body in sections)

        context = assemble(recent, thread)
        while len(context) > MAX_CONTEXT_CHARS and recent:
            recent.pop(0)
            context = assemble(recent, thread)
        while len(context) > MAX_CONTEXT_CHARS and len(thread) > 1:
            thread.pop(1 if thread[0].id == root_id else 0)
            context = assemble(recent, thread)
        if len(context) > MAX_CONTEXT_CHARS:
            overflow = len(context) - MAX_CONTEXT_CHARS
            trigger_heading, trigger_body = fixed_sections[3]
            fixed_sections[3] = (trigger_heading, trigger_body[:-overflow])
            context = assemble(recent, thread)
        return context

    def for_classifier(self, message: MessageRecord) -> tuple[str, str]:
        channel = self.repository.require_channel(message.channel_id)
        profiles = [
            member.profile_id
            for member in self.repository.list_members(message.channel_id)
            if member.activation_policy != "disabled"
        ]
        intents = (
            "inform, result, reply_required, question, handoff, review_request, "
            "blocked, approval_request"
        )
        instructions = (
            "Return JSON only: one object with intent, recipients, and confidence.\n"
            f"Enabled profile ids: {', '.join(profiles)}\n"
            f"Allowed intents: {intents}.\n"
            "Recipients must be selected only from the enabled profile ids.\n"
            "When uncertain return "
            '{"intent":"inform","recipients":[],"confidence":0}'
        )
        recent = self.repository.list_messages(message.channel_id)[-MAX_RECENT_MESSAGES:]
        input_text = (
            f"Channel: #{channel.name}\n"
            f"Purpose: {channel.purpose or '(none)'}\n"
            f"Message: {_bounded_content(message.content)}\n"
            "Recent channel:\n"
            + "\n".join(_format_message(item) for item in recent)
        )
        return instructions, input_text[:MAX_CONTEXT_CHARS]
