# Changelog

## 0.1.0 — 2026-08-12

Initial Hermes Crew release for one local user:

- Profile-backed crew members with independent Hermes model, provider, SOUL, skills, and tool configuration.
- Project-aware channels, message-scoped projects, inherited thread context, mentions, default responders, and per-channel activation policies.
- Structured hidden intent envelopes, deterministic reply routing, bounded handoffs, optional classifier configuration disabled by default, and durable activity/approval controls.
- SQLite persistence, restart recovery, full-text search, first-run onboarding, Crew Studio, installer, and reproducible release packaging.
- Hermes Desktop 0.20.0 runtime-loader compatibility verification for generated plugin imports.
- Completed agent turns now refresh their channel message stream, so persisted replies appear without leaving the channel.
- Crew Studio's native Hermes model catalog now renders inside the required dropdown context.

### Acceptance evidence

- Automated release gate: 60 Python tests and 29 TypeScript/UI tests passed with no skipped acceptance scenarios.
- Hermes Agent: `0.20.0` (`2026.8.3`).
- Hermes Desktop package: `0.17.0`.
- Pinned Desktop SDK contract commit: `ee472a7fdbbc55924f91ab122dbaa29bd07668b0`.
- Host: Linux `7.1.4-arch1-1`, x86_64.
- Crew database schema: `2`.
- Desktop plugin SHA-256: `0db0a1e5649a73b2757c40c05ce12d1bb4d26856de04edfc4420996107d8e247`.
- Release archive SHA-256: `21f74bdcab1a5b896eff7ad0bb286a8a1743b678cea619046514d3b80a2520ea`.

A disposable real `HERMES_HOME` smoke test installed and enabled the packaged user plugin in Hermes 0.20.0, loaded its FastAPI routes, and created two `--no-skills` profiles: Atlas on OpenAI/GPT-5.6 and Scout on Google/Gemini 2.5 Pro. The real Crew API returned both profile configurations, routed a global message to mentioned Scout plus default Atlas, resolved a registered Hermes project into the Atlas claim's `cwd`, cancelled only Scout, preserved the Crew database across reinstall, and marked the remaining Atlas claims interrupted after backend restart.

The disposable home intentionally contained no provider credentials, so it made no billed model requests and did not claim a GUI streaming result. The contract-recording acceptance gateway covers independent effective models, completion markers, zero-child informational results, review/handoff bounds, project/thread inheritance, scoped stop, approval rejection, restart idempotency, and missing profile/model/project readiness failures.
