# Hermes Crew

Hermes Crew is a local, single-user workspace where persistent Hermes profiles collaborate in channels and project-scoped threads. Hermes remains authoritative for every profile's provider, model, SOUL, skills, tools, credentials, memory, projects, and sessions.

Compatibility floor: **Hermes Agent 0.20.0**. The pinned Desktop Plugin SDK baseline is package **0.17.0** at upstream commit `ee472a7fdbbc55924f91ab122dbaa29bd07668b0`.

## Build and install

Prerequisites are Node 22.22+, Python 3.11+, and Hermes Agent 0.20.0.

```bash
npm install
npm run build
npm run verify:dist
python scripts/install.py
```

`HERMES_HOME` selects the owner profile (default `~/.hermes`). The installer copies the Desktop plugin to `desktop-plugins/hermes-crew`, installs and enables the scoped Python plugin under `plugins/hermes-crew`, and leaves member profile homes untouched. Restart or reload Hermes Desktop, enable Hermes Crew if needed, then choose **Crew** in the sidebar.

The first-run screen creates `#general`, selects one default responder, uses global context, adds other profiles as mention-only members, and keeps the optional classifier off.

## How project scope works

An unassigned channel or message uses the selected profile's global Hermes context. A channel can have a default Hermes project. A single message in a general channel can attach a project without changing later channel messages. Its thread inherits that project and receives isolated per-profile Hermes session bindings.

Crew project allow-lists only narrow routing. Profile identity and SOUL are not filesystem sandboxes; actual access and approval enforcement remain with Hermes execution and sandbox controls.

## Data, recovery, and upgrades

Coordination data lives at `$HERMES_HOME/crew/crew.db` with SQLite WAL enabled. Back up the database together with `crew.db-wal` and `crew.db-shm` while Hermes is stopped, or use SQLite's backup tooling. Agent sessions and profile-owned state remain in Hermes.

To upgrade, build the new version and run `python scripts/install.py` again. Installation is idempotent and preserves `crew/crew.db`. Runtime/backend errors appear in Hermes Desktop logs; Crew activity remains available through its durable journal after reload.

```bash
# Remove installed code, preserve Crew data
python scripts/install.py --uninstall

# Explicitly remove installed code and Crew data
python scripts/install.py --uninstall --purge-data
```

## Development verification

```bash
npm test
npm run typecheck
pytest -q
npm run build
npm run verify:dist
npm run package
```
