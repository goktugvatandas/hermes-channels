#!/usr/bin/env python3
"""Install Hermes Crew into one owner Hermes home."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def _atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def _enable_plugin(config_path: Path) -> None:
    text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    if any(line.strip() == "- hermes-crew" for line in text.splitlines()):
        return
    lines = text.splitlines()
    plugins_index = next((index for index, line in enumerate(lines) if line == "plugins:"), None)
    if plugins_index is None:
        if lines and lines[-1]:
            lines.append("")
        lines.extend(("plugins:", "  enabled:", "    - hermes-crew"))
    else:
        end = next((index for index in range(plugins_index + 1, len(lines)) if lines[index] and not lines[index].startswith(" ")), len(lines))
        enabled_index = next((index for index in range(plugins_index + 1, end) if lines[index].strip().startswith("enabled:")), None)
        if enabled_index is None:
            lines[plugins_index + 1:plugins_index + 1] = ["  enabled:", "    - hermes-crew"]
        elif lines[enabled_index].strip() == "enabled: []":
            lines[enabled_index:enabled_index + 1] = ["  enabled:", "    - hermes-crew"]
        else:
            insert_at = enabled_index + 1
            while insert_at < end and lines[insert_at].startswith("    - "):
                insert_at += 1
            lines.insert(insert_at, "    - hermes-crew")
    _atomic_text(config_path, "\n".join(lines).rstrip() + "\n")


def install(home: Path) -> None:
    bundle = ROOT / "dist" / "desktop-plugins" / "hermes-crew" / "plugin.js"
    backend_bundle = ROOT / "dist" / "plugins" / "hermes-crew"
    dashboard_bundle = backend_bundle / "dashboard" / "dist" / "index.js"
    if not bundle.is_file() or not dashboard_bundle.is_file():
        raise SystemExit("Hermes Crew bundles are missing. Run `npm run build` first.")
    desktop_target = home / "desktop-plugins" / "hermes-crew"
    backend_target = home / "plugins" / "hermes-crew"
    desktop_target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bundle, desktop_target / "plugin.js")
    if backend_target.exists():
        shutil.rmtree(backend_target)
    shutil.copytree(backend_bundle, backend_target)
    # Install only the leaves this bundle owns: users may add their own skills
    # under the hermes-crew category, and those must survive reinstalls.
    skills_bundle = ROOT / "dist" / "skills" / "hermes-crew"
    if skills_bundle.is_dir():
        skills_target = home / "skills" / "hermes-crew"
        skills_target.mkdir(parents=True, exist_ok=True)
        for entry in skills_bundle.iterdir():
            destination = skills_target / entry.name
            if entry.is_dir():
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(entry, destination)
            else:
                shutil.copy2(entry, destination)
    (home / "crew").mkdir(parents=True, exist_ok=True)
    _enable_plugin(home / "config.yaml")
    print("Hermes Crew installed for owner profile:", home)
    print("Restart or reload Hermes Desktop, enable Hermes Crew, then open Crew from the sidebar.")


def uninstall(home: Path, purge_data: bool) -> None:
    for target in (
        home / "desktop-plugins" / "hermes-crew",
        home / "plugins" / "hermes-crew",
    ):
        if target.exists():
            shutil.rmtree(target)
    # Remove only the skill leaves this bundle vendors; user-added skills in
    # the same category are preserved (and the category dir if non-empty).
    skills_target = home / "skills" / "hermes-crew"
    for vendored in ("crew-collaboration", "DESCRIPTION.md"):
        leaf = skills_target / vendored
        if leaf.is_dir():
            shutil.rmtree(leaf)
        elif leaf.is_file():
            leaf.unlink()
    if skills_target.is_dir() and not any(skills_target.iterdir()):
        skills_target.rmdir()
    if purge_data and (home / "crew").exists():
        shutil.rmtree(home / "crew")
    print("Hermes Crew code removed. Crew data was " + ("purged." if purge_data else "preserved."))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-home", type=Path)
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--purge-data", action="store_true")
    args = parser.parse_args()
    home = args.hermes_home or Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    if args.purge_data and not args.uninstall:
        parser.error("--purge-data requires --uninstall")
    uninstall(home, args.purge_data) if args.uninstall else install(home)


if __name__ == "__main__":
    main()
