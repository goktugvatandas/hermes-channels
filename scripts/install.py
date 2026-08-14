#!/usr/bin/env python3
"""Install Hermes Channels into one owner Hermes home."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]

# Load the shared YAML editor directly so the installer remains stdlib-only;
# importing the backend package would execute __init__ and require pydantic.
import importlib.util

_backend_roots = (
    ROOT / "src" / "backend",
    ROOT / "plugins" / "hermes-channels" / "dashboard",
)
for _backend_root in _backend_roots:
    _enablement_path = _backend_root / "hermes_channels_backend" / "profile_enablement.py"
    if _enablement_path.is_file():
        break
else:
    raise SystemExit("Hermes Channels backend files are missing.")
_enablement_spec = importlib.util.spec_from_file_location(
    "_hermes_channels_profile_enablement", _enablement_path
)
assert _enablement_spec is not None and _enablement_spec.loader is not None
_enablement = importlib.util.module_from_spec(_enablement_spec)
_enablement_spec.loader.exec_module(_enablement)
enable_plugin_in_config = _enablement.enable_plugin_in_config
remove_plugin_from_config = _enablement.remove_plugin_from_config
sync_collaboration_skill = _enablement.sync_collaboration_skill

LEGACY_NAME = "hermes-crew"


def migrate_legacy(home: Path) -> None:
    """One-time cleanup of a hermes-crew era install: without this an upgrade
    leaves BOTH plugin generations enabled (duplicate UIs, two workers, two
    databases) and orphaned cron jobs firing into a dead workspace."""

    for stale in (
        home / "plugins" / LEGACY_NAME,
        home / "desktop-plugins" / LEGACY_NAME,
        home / "skills" / LEGACY_NAME,
    ):
        if stale.exists():
            shutil.rmtree(stale)
    config = home / "config.yaml"
    if config.exists():
        remove_plugin_from_config(config, LEGACY_NAME)
    # Adopt the old workspace database if the new one doesn't exist yet.
    old_db = home / "crew" / "crew.db"
    new_db = home / "channels" / "channels.db"
    if old_db.exists() and not new_db.exists():
        new_db.parent.mkdir(parents=True, exist_ok=True)
        for suffix in ("", "-wal", "-shm"):
            source = Path(str(old_db) + suffix)
            if source.exists():
                shutil.move(str(source), str(new_db) + suffix)
        print("Adopted existing workspace:", old_db, "->", new_db)
    # Remove orphaned schedule scripts and their cron jobs.
    scripts_dir = home / "scripts"
    if scripts_dir.is_dir():
        for script in scripts_dir.glob("crew-schedule-*.py"):
            script.unlink(missing_ok=True)
    jobs_file = home / "cron" / "jobs.json"
    if jobs_file.exists():
        try:
            import json

            data = json.loads(jobs_file.read_text(encoding="utf-8"))
            jobs = data if isinstance(data, list) else data.get("jobs", [])
            kept = [job for job in jobs if job.get("origin") != LEGACY_NAME]
            if len(kept) != len(jobs):
                if isinstance(data, list):
                    jobs_file.write_text(json.dumps(kept, indent=2), encoding="utf-8")
                else:
                    data["jobs"] = kept
                    jobs_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
                print(f"Removed {len(jobs) - len(kept)} orphaned {LEGACY_NAME} cron job(s)")
        except Exception:
            print("Warning: could not clean legacy cron jobs in", jobs_file)


def install(home: Path, layout: str = "standalone") -> None:
    bundle_root = ROOT / "dist" if (ROOT / "dist").is_dir() else ROOT
    bundle = bundle_root / "desktop-plugins" / "hermes-channels" / "plugin.js"
    backend_bundle = bundle_root / "plugins" / "hermes-channels"
    dashboard_bundle = backend_bundle / "dashboard" / "dist" / "index.js"
    if not bundle.is_file() or not dashboard_bundle.is_file():
        raise SystemExit("Hermes Channels bundles are missing. Run `npm run build` first.")
    migrate_legacy(home)
    backend_target = home / "plugins" / "hermes-channels"
    if backend_target.exists():
        shutil.rmtree(backend_target)
    shutil.copytree(backend_bundle, backend_target)
    legacy_desktop = home / "desktop-plugins" / "hermes-channels"
    if layout == "unified":
        # One folder ships both halves (desktop shells newer than mid-2026
        # scan plugins/<id>/desktop/plugin.js). Remove the standalone copy so
        # the plugin inventory shows a single row.
        unified_desktop = backend_target / "desktop"
        unified_desktop.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundle, unified_desktop / "plugin.js")
        if legacy_desktop.exists():
            shutil.rmtree(legacy_desktop)
    else:
        legacy_desktop.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundle, legacy_desktop / "plugin.js")
    # Install only the leaves this bundle owns: users may add their own skills
    # under the hermes-channels category, and those must survive reinstalls.
    skills_bundle = bundle_root / "skills" / "hermes-channels"
    if skills_bundle.is_dir():
        skills_target = home / "skills" / "hermes-channels"
        skills_target.mkdir(parents=True, exist_ok=True)
        for entry in skills_bundle.iterdir():
            destination = skills_target / entry.name
            if entry.is_dir():
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(entry, destination)
            else:
                shutil.copy2(entry, destination)
    (home / "channels").mkdir(parents=True, exist_ok=True)
    enable_plugin_in_config(home / "config.yaml")
    # Worker turns run under each profile's own HERMES_HOME, where the owner
    # home's skill is invisible — sync the collaboration skill per profile so
    # bots actually have the guide the response contract points at. The
    # backend repeats this sweep at runtime for profiles created later.
    profiles_dir = home / "profiles"
    if profiles_dir.is_dir():
        os.environ["HERMES_HOME"] = str(home)
        synced = sum(
            1
            for profile in sorted(profiles_dir.iterdir())
            if profile.is_dir() and sync_collaboration_skill(profile)
        )
        if synced:
            print(f"channel-collaboration skill synced to {synced} profile(s)")
    print("Hermes Channels installed for owner profile:", home)
    print("Restart or reload Hermes Desktop, enable Hermes Channels, then open Channels from the sidebar.")


def uninstall(home: Path, purge_data: bool) -> None:
    for target in (
        home / "desktop-plugins" / "hermes-channels",
        home / "plugins" / "hermes-channels",
        home / "desktop-plugins" / LEGACY_NAME,
        home / "plugins" / LEGACY_NAME,
        home / "skills" / LEGACY_NAME,
    ):
        if target.exists():
            shutil.rmtree(target)
    # Remove only the skill leaves this bundle vendors; user-added skills in
    # the same category are preserved (and the category dir if non-empty).
    skills_target = home / "skills" / "hermes-channels"
    for vendored in ("channel-collaboration", "DESCRIPTION.md"):
        leaf = skills_target / vendored
        if leaf.is_dir():
            shutil.rmtree(leaf)
        elif leaf.is_file():
            leaf.unlink()
    if skills_target.is_dir() and not any(skills_target.iterdir()):
        skills_target.rmdir()
    if purge_data and (home / "channels").exists():
        shutil.rmtree(home / "channels")
    config = home / "config.yaml"
    if config.exists():
        remove_plugin_from_config(config, "hermes-channels")
    print("Hermes Channels code removed. Channels data was " + ("purged." if purge_data else "preserved."))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-home", type=Path)
    parser.add_argument(
        "--layout",
        choices=("standalone", "unified"),
        default="standalone",
        help="unified: ship the desktop half inside plugins/hermes-channels/desktop/ "
        "(requires a desktop shell newer than mid-2026); standalone (default): "
        "desktop-plugins/hermes-channels/, works everywhere.",
    )
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--purge-data", action="store_true")
    args = parser.parse_args()
    home = args.hermes_home or Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    if args.purge_data and not args.uninstall:
        parser.error("--purge-data requires --uninstall")
    uninstall(home, args.purge_data) if args.uninstall else install(home, args.layout)


if __name__ == "__main__":
    main()
