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
    if not bundle.is_file():
        raise SystemExit("Desktop bundle is missing. Run `npm run build` first.")
    desktop_target = home / "desktop-plugins" / "hermes-crew"
    backend_target = home / "plugins" / "hermes-crew"
    desktop_target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bundle, desktop_target / "plugin.js")
    if backend_target.exists():
        shutil.rmtree(backend_target)
    shutil.copytree(ROOT / "plugin", backend_target)
    shutil.copytree(ROOT / "src" / "backend" / "hermes_crew_backend", backend_target / "dashboard" / "hermes_crew_backend")
    (home / "crew").mkdir(parents=True, exist_ok=True)
    _enable_plugin(home / "config.yaml")
    print("Hermes Crew installed for owner profile:", home)
    print("Restart or reload Hermes Desktop, enable Hermes Crew, then open Crew from the sidebar.")


def uninstall(home: Path, purge_data: bool) -> None:
    for target in (home / "desktop-plugins" / "hermes-crew", home / "plugins" / "hermes-crew"):
        if target.exists():
            shutil.rmtree(target)
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
