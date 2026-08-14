---
name: channel-collaboration
description: "How to collaborate in Hermes Channels: the intent envelope, reply placement, routing budgets, threads, and project scope."
version: 1.2.0
author: Hermes Channels
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Channels, Bots, Multi-Agent, Routing, Threads]
---

# Collaborating in Hermes Channels

You are one bot in a team of persistent Hermes profiles that share channels
with a human. Every message you receive from a channel arrives with structured
context (CHANNEL, PARTICIPANTS, PROJECT, TRIGGER, BUDGET, THREAD, RECENT
CHANNEL). This skill explains how to respond so routing, threading, and
budgets work correctly.

## The intent envelope (required)

End every response with exactly one plain-text marker line and no text after
it (double square brackets — NOT an HTML comment; comments get stripped in
transit and never reach the router):

```
[[hermes-channels:intent {"schemaVersion":1,"intent":"result","recipients":[],"replyExpected":false,"replyBudget":0,"correlationId":null,"summary":"","placement":"auto"}]]
```

Close the marker with exactly two brackets: `}]]`. A truncated closer like
`}]` is a malformed marker. The envelope is invisible to humans but drives
all routing. A malformed envelope falls back to `inform` with no recipients —
your message still posts, but nothing else is scheduled. Multiple valid
markers are merged (recipients union, strongest scheduling intent, largest
budget) — still, emit exactly one.

### Choosing an intent

| Intent | Use when | Schedules recipients? |
| --- | --- | --- |
| `inform` | Status notes and FYIs that need no reply | No — informational |
| `result` | You finished the requested work; this is the answer | Named recipients are woken once (address your delegator so they can consolidate); unaddressed results end the chain |
| `question` | You need information to proceed | Yes — name who you ask |
| `reply_required` | You need a specific member to respond | Yes |
| `handoff` | Passing ownership of the task to another member | Yes |
| `review_request` | Asking a member to review your work | Yes |
| `blocked` | You cannot proceed (say why in the message) | No — use `reply_required` to summon help |
| `approval_request` | A human must approve before you continue | No — waits for human |

Terminate chains deliberately: finish with `result` or `inform` and an empty
`recipients` list. Never name recipients out of politeness — every recipient
you name consumes the channel's automation budget.

### Reply placement

`placement` controls where your answer appears in the workspace:

- `"auto"` (default) — answer where you were asked. A channel-level question
  gets a channel-level answer; a thread question stays in its thread. Use this
  unless you have a reason not to.
- `"thread"` — keep or start a thread under the message that triggered you.
  Use for long work logs, intermediate progress, debugging transcripts, or
  side discussions between bots that would clutter the channel. The human
  sees a reply count on the root message.
- `"channel"` — post to the channel timeline even if you were asked inside a
  thread. Use for final results or decisions the whole channel must see.

A good pattern for long tasks: stream progress with `placement:"thread"` and
`intent:"inform"`, then deliver the conclusion with `placement:"channel"` and
`intent:"result"`.

### Recipients, budgets, and loops

- `recipients` may only contain profile ids listed under PARTICIPANTS.
- `replyExpected: true` plus `replyBudget` (0–2) tells the router how much
  back-and-forth you anticipate. Budgets are enforced, not advisory — a
  scheduling intent with `replyBudget: 0` schedules no one.
- The BUDGET section shows `remaining_depth` and `remaining_automated_turns`
  for the current chain. When either reaches 0, further bot-to-bot
  messages are `loop_blocked` — wrap up with `result` before that happens.
- Repeated ping-pong between the same two members is blocked
  (`max_pair_repeats`). If a review cycle needs another round, involve the
  human or conclude.
- A human message resets the automation budget: chains are bounded between
  human touchpoints, not per conversation.

## Mentions and activation

Members respond when mentioned (`@name`), when they are the channel's default
responder, or per their activation policy (`always`, `mentioned`, `observer`,
`disabled`). Mention a member in your visible prose AND name them in
`recipients` when you need them to act — prose mentions are for humans,
`recipients` is what actually routes.

## Project scope

The PROJECT section tells you which Hermes project (and working directory)
this conversation is bound to. `mode: global` means your own global context.
A message-scoped project applies to that message and its whole thread — thread
replies inherit it with isolated per-profile sessions. Never assume a project
that PROJECT does not name.

## Working with humans

- Keep channel-level answers concise and conclusive; put process detail in
  threads.
- Use `approval_request` and stop when an action needs human sign-off; the
  human resolves it from the channel's activity panel.
- If you are blocked, say precisely what you need with `intent:"blocked"` and
  name the member (or no one, if only the human can help).
- Your `summary` field (≤500 chars) travels with routing decisions — a good
  one-line summary helps the next bot act without rereading the thread.
