# Development

## Prerequisites

- Node 22.22+ and Python 3.11+ (`python -m venv .venv && .venv/bin/pip install -e . pytest` or use your environment manager)
- A local Hermes Agent 0.20.0 install for end-to-end work (`HERMES_HOME`, default `~/.hermes`)

## Everyday loop

```bash
npm test              # vitest (jsdom) — UI, contracts, e2e journey
npm run typecheck
python -m pytest -q   # backend: routing, scheduler, api, integration
npm run build         # both bundles + both scoped stylesheets + skills
npm run verify:dist   # dist invariants; run before installing
python scripts/install.py
```

`verify:dist` enforces the constraints that keep both hosts working; treat a
failure as a real bug, not an obstacle:

- the Desktop bundle's only imports are `@hermes/plugin-sdk` and React (the
  Desktop runtime-loader scans string literals too),
- the Desktop bundle inlines its scoped utility styles,
- the dashboard bundle self-registers and contains no module syntax,
- both stylesheets are fully scoped (no selector leaks into host chrome).

After installing, restart whatever loads the backend. **The Hermes Desktop app
embeds its own `hermes serve`; backend changes require restarting the app**,
not just reloading its window. The web dashboard process must also be
restarted (`hermes dashboard`).

## Visual verification harness

UI work should be verified in a real browser, not only jsdom. The pattern that
works (no dev-server exists for plugin bundles):

1. Create a scratch dir with `index.html` that stubs
   `window.__HERMES_PLUGIN_SDK__` (React + a `fetchJSON` router over fixture
   data) and `window.__HERMES_PLUGINS__.register`, then loads the built
   `dashboard/dist/index.js` and `style.css`.
2. Bundle the stub with esbuild (`--alias:react=<repo>/node_modules/react`).
3. Serve with `python -m http.server`, screenshot with `puppeteer-core`
   driving system Chrome (`waitUntil: 'networkidle0'` + a short settle delay).

Two hard-won rules: headless Chrome's `--screenshot` flag captures stale
frames for React apps — always screenshot through puppeteer; and verify colors
with pixel probes (`magick … '%[pixel:p{x,y}]'`) rather than eyeballing
downscaled images.

For the real hosts, screenshot the dashboard at `http://127.0.0.1:9119` the
same way. The Desktop app can only be verified by using it — its plugin
runtime has no remote debugging.

## Host quirks worth knowing before debugging

- **Desktop ships no utility CSS for plugins.** Anything styled with a class
  the host doesn't define renders unstyled. That's why the build compiles and
  inlines a scoped stylesheet; if layout collapses in Desktop but not the
  dashboard, suspect the stylesheet pipeline first.
- **Desktop `host.navigate` resolves plugin routes only.** Core routes,
  hashes, and `history.pushState` do not reach the host router. `window.open`
  does reach the system browser.
- **The dashboard styles `code` globally.** Always give Crew's `code`/`kbd`
  elements explicit background and text utilities.
- **Both hosts wrap the plugin in chrome of unknown width.** Use container
  queries (`@2xl:` …), never viewport breakpoints.
- **The journal appends informational events after terminal ones.** Derive
  turn state from state-bearing event types only (`conversation-model.ts`).

## Tests

- `tests/desktop/` — component and contract tests. They encode accessible
  names and labels ('Message', 'Project scope', '@name' chips, option roles);
  when changing UI copy, update tests deliberately, and keep decorative
  avatars `aria-hidden` so they don't pollute accessible names.
- `tests/backend/` + `tests/integration/` — routing budgets, scheduler
  lifecycle, placement, recovery. `fake_hermes.py` simulates the gateway.
- `tests/e2e/crew.spec.ts` — the acceptance journey: land on Home, open a
  workspace, scope a message to a project, mention a specialist, send.

## Release

```bash
npm run package   # dist/release/hermes-channels-<version>.tar.gz
```

The tarball contains install-ready `desktop-plugins/`, `plugins/`, and
`skills/` trees plus the installer, documentation, license, and metadata.
