"""Keep the plugin enabled for every Hermes profile.

The desktop routes plugin REST calls to the ACTIVE profile's backend, and
opening a bot's direct chat switches the active profile — so every profile's
own ``config.yaml`` must list the plugin under ``plugins.enabled`` or the
whole Channels UI answers 404 ("Plugin not found") the moment a chat opens.
Profiles created outside our API (Bot Mode, the CLI) never pass through the
installer, so the backend self-heals: idempotent, line-preserving, and
best-effort — a read-only home must never break a request.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

PLUGIN_NAME = "hermes-channels"

_log = logging.getLogger(__name__)
_healed: set[str] = set()


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def _atomic_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def _parse_flow(snippet: str):
    try:
        import yaml

        return yaml.safe_load(snippet)
    except Exception:
        pass

    # The release installer deliberately has no third-party imports. Support
    # the small flow-style subset Hermes uses even when PyYAML is unavailable.
    def split_items(value: str) -> list[str] | None:
        items: list[str] = []
        start = 0
        depth = 0
        quote = ""
        escaped = False
        for index, character in enumerate(value):
            if escaped:
                escaped = False
                continue
            if character == "\\" and quote:
                escaped = True
                continue
            if character in {'"', "'"}:
                if quote == character:
                    quote = ""
                elif not quote:
                    quote = character
                continue
            if quote:
                continue
            if character in "[{":
                depth += 1
            elif character in "]}":
                depth -= 1
            elif character == "," and depth == 0:
                items.append(value[start:index].strip())
                start = index + 1
        if quote or depth != 0:
            return None
        items.append(value[start:].strip())
        return [item for item in items if item]

    def scalar(value: str) -> str:
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            return value[1:-1]
        return value

    source = snippet.strip()
    if source.startswith("[") and source.endswith("]"):
        items = split_items(source[1:-1])
        return [scalar(item) for item in items] if items is not None else None
    if source.startswith("{") and source.endswith("}"):
        items = split_items(source[1:-1])
        if items is None:
            return None
        result: dict[str, object] = {}
        for item in items:
            key, separator, value = item.partition(":")
            if not separator:
                return None
            parsed = _parse_flow(value) if value.strip().startswith("[") else scalar(value)
            if parsed is None:
                return None
            result[scalar(key)] = parsed
        return result
    return scalar(source) if source else None


def enable_plugin_in_config(config_path: Path) -> bool:
    """Insert ``- hermes-channels`` under ``plugins.enabled`` (creating the
    sections when absent). Line-preserving for block-style configs; flow-style
    forms (``plugins: {...}``, ``enabled: [a, b]``) are parsed and rewritten
    in place rather than blindly line-spliced — a wrong guess here corrupts a
    profile's whole plugin list. Returns True when the file was changed."""

    text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    if any(line.strip() == f"- {PLUGIN_NAME}" for line in text.splitlines()):
        return False
    if f"{PLUGIN_NAME}" in text and re.search(
        rf"enabled:\s*\[[^\]]*\b{re.escape(PLUGIN_NAME)}\b", text
    ):
        return False
    lines = text.splitlines()

    # ``plugins: {enabled: [...]}`` — a flow mapping on one line. Rewrite just
    # that line as an equivalent block; appending a second ``plugins:`` key
    # would let YAML's last-key-wins silently drop the original list.
    for index, line in enumerate(lines):
        match = re.match(r"^plugins:\s*(\{.*)$", line)
        if not match:
            continue
        parsed = _parse_flow(match.group(1))
        if not isinstance(parsed, dict):
            return False  # unrecognized shape: never risk corrupting it
        enabled = parsed.get("enabled")
        enabled = list(enabled) if isinstance(enabled, list) else []
        if PLUGIN_NAME not in enabled:
            enabled.append(PLUGIN_NAME)
        parsed["enabled"] = enabled
        block = ["plugins:"]
        for key, value in parsed.items():
            if isinstance(value, list):
                block.append(f"  {key}:")
                block.extend(f"    - {item}" for item in value)
            else:
                block.append(f"  {key}: {value}")
        lines[index:index + 1] = block
        _atomic_write(config_path, "\n".join(lines).rstrip() + "\n")
        return True

    plugins_index = next(
        (
            index
            for index, line in enumerate(lines)
            if re.match(r"^plugins:\s*$", line)
        ),
        None,
    )
    if plugins_index is None:
        if lines and lines[-1]:
            lines.append("")
        lines.extend(("plugins:", "  enabled:", f"    - {PLUGIN_NAME}"))
    else:
        end = next(
            (
                index
                for index in range(plugins_index + 1, len(lines))
                if lines[index] and not lines[index].startswith(" ")
            ),
            len(lines),
        )
        enabled_index = next(
            (
                index
                for index in range(plugins_index + 1, end)
                if lines[index].strip().startswith("enabled:")
            ),
            None,
        )
        if enabled_index is None:
            lines[plugins_index + 1:plugins_index + 1] = [
                "  enabled:",
                f"    - {PLUGIN_NAME}",
            ]
        elif re.match(r"^\s*enabled:\s*\[", lines[enabled_index].strip() and lines[enabled_index] or ""):
            # ``enabled: [a, b]`` flow list — extend it inline.
            indent = lines[enabled_index][: len(lines[enabled_index]) - len(lines[enabled_index].lstrip())]
            parsed = _parse_flow(lines[enabled_index].split(":", 1)[1])
            if not isinstance(parsed, list):
                return False
            if PLUGIN_NAME not in parsed:
                parsed.append(PLUGIN_NAME)
            rendered = ", ".join(str(item) for item in parsed)
            lines[enabled_index] = f"{indent}enabled: [{rendered}]"
        elif lines[enabled_index].strip() == "enabled: []":
            lines[enabled_index:enabled_index + 1] = [
                "  enabled:",
                f"    - {PLUGIN_NAME}",
            ]
        else:
            insert_at = enabled_index + 1
            while insert_at < end and lines[insert_at].startswith("    - "):
                insert_at += 1
            lines.insert(insert_at, f"    - {PLUGIN_NAME}")
    _atomic_write(config_path, "\n".join(lines).rstrip() + "\n")
    return True


def remove_plugin_from_config(config_path: Path, plugin_name: str) -> bool:
    """Remove one plugin from ``plugins.enabled`` without rewriting unrelated YAML."""

    if not config_path.exists():
        return False
    lines = config_path.read_text(encoding="utf-8").splitlines()
    changed = False

    for index, line in enumerate(lines):
        match = re.match(r"^plugins:\s*(\{.*)$", line)
        if not match:
            continue
        parsed = _parse_flow(match.group(1))
        if not isinstance(parsed, dict) or not isinstance(parsed.get("enabled"), list):
            return False
        enabled = [item for item in parsed["enabled"] if item != plugin_name]
        if len(enabled) == len(parsed["enabled"]):
            return False
        parsed["enabled"] = enabled
        block = ["plugins:"]
        for key, value in parsed.items():
            if isinstance(value, list):
                block.append(f"  {key}:")
                block.extend(f"    - {item}" for item in value)
            else:
                block.append(f"  {key}: {value}")
        lines[index:index + 1] = block
        changed = True
        break

    if not changed:
        plugins_index = next(
            (index for index, line in enumerate(lines) if re.match(r"^plugins:\s*$", line)),
            None,
        )
        if plugins_index is None:
            return False
        end = next(
            (
                index
                for index in range(plugins_index + 1, len(lines))
                if lines[index] and not lines[index].startswith(" ")
            ),
            len(lines),
        )
        enabled_index = next(
            (
                index
                for index in range(plugins_index + 1, end)
                if lines[index].strip().startswith("enabled:")
            ),
            None,
        )
        if enabled_index is None:
            return False
        inline = lines[enabled_index].split(":", 1)[1].strip()
        if inline.startswith("["):
            parsed = _parse_flow(inline)
            if not isinstance(parsed, list) or plugin_name not in parsed:
                return False
            parsed = [item for item in parsed if item != plugin_name]
            indent = lines[enabled_index][:
                len(lines[enabled_index]) - len(lines[enabled_index].lstrip())
            ]
            lines[enabled_index] = f"{indent}enabled: [{', '.join(str(item) for item in parsed)}]"
            changed = True
        else:
            index = enabled_index + 1
            while index < end and (not lines[index] or lines[index].startswith("    ")):
                if lines[index].strip() == f"- {plugin_name}":
                    lines.pop(index)
                    end -= 1
                    changed = True
                    continue
                index += 1

    if changed:
        _atomic_write(config_path, "\n".join(lines).rstrip() + "\n")
    return changed


PLUGIN_VERSION_PATTERN = re.compile(
    r'^version:\s*["\']?([^"\'\s]+)["\']?\s*$', re.MULTILINE
)


def _plugin_version(plugin_dir: Path) -> str | None:
    try:
        match = PLUGIN_VERSION_PATTERN.search(
            (plugin_dir / "plugin.yaml").read_text(encoding="utf-8")
        )
    except OSError:
        return None
    return match.group(1) if match else None


def sync_plugin_bundle(profile_dir: Path) -> bool:
    """Install the owner plugin into a profile so its hook manager can load it."""

    source = _hermes_home() / "plugins" / PLUGIN_NAME
    if not (source / "plugin.yaml").is_file():
        return False
    target = profile_dir / "plugins" / PLUGIN_NAME
    source_version = _plugin_version(source)
    if source_version and _plugin_version(target) == source_version:
        return False

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{PLUGIN_NAME}-sync-", dir=target.parent
    ) as temporary:
        staged = Path(temporary) / PLUGIN_NAME
        shutil.copytree(
            source,
            staged,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
        )
        backup = target.with_name(f".{PLUGIN_NAME}-previous")
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            target.replace(backup)
        try:
            staged.replace(target)
        except Exception:
            if backup.exists() and not target.exists():
                backup.replace(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    return True


SKILL_NAME = "channel-collaboration"

_SKILL_VERSION = re.compile(r"^version:\s*([0-9][0-9.]*)\s*$", re.MULTILINE)


def _skill_version(skill_md: Path) -> str | None:
    try:
        match = _SKILL_VERSION.search(skill_md.read_text(encoding="utf-8"))
    except OSError:
        return None
    return match.group(1) if match else None


def sync_collaboration_skill(profile_dir: Path) -> bool:
    """Copy the bundled channel-collaboration skill into one profile.

    Worker turns run under the profile's own HERMES_HOME, so the skill
    installed in the owner home is invisible to them — without this sync,
    bots never see the collaboration guide the response contract points at.
    Synced when the profile copy is missing or carries a different version;
    a version-matched copy is left alone so local edits survive.
    """

    source = _hermes_home() / "skills" / PLUGIN_NAME / SKILL_NAME / "SKILL.md"
    if not source.is_file():
        return False
    target = profile_dir / "skills" / SKILL_NAME / "SKILL.md"
    if target.is_file() and _skill_version(target) == _skill_version(source):
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(target, source.read_text(encoding="utf-8"))
    return True


def ensure_profiles_enabled(profile_names: list[str] | None = None) -> int:
    """Heal profile configs, plugin bundles, and skill copies; cached per process."""

    healed = 0
    try:
        profiles_dir = _hermes_home() / "profiles"
        names = profile_names
        if names is None:
            names = (
                [entry.name for entry in profiles_dir.iterdir() if entry.is_dir()]
                if profiles_dir.is_dir()
                else []
            )
        for name in names:
            if name in _healed:
                continue
            config = profiles_dir / name / "config.yaml"
            if not (profiles_dir / name).is_dir():
                continue
            try:
                if enable_plugin_in_config(config):
                    healed += 1
                    _log.info("enabled %s for profile %s", PLUGIN_NAME, name)
                if sync_plugin_bundle(profiles_dir / name):
                    _log.info("synced %s plugin to profile %s", PLUGIN_NAME, name)
                if sync_collaboration_skill(profiles_dir / name):
                    _log.info("synced %s skill to profile %s", SKILL_NAME, name)
                _healed.add(name)
            except Exception:
                # Negative-cache: a read-only or broken config should not be
                # re-probed on every roster poll.
                _healed.add(name)
                _log.debug("profile enablement skipped for %s", name, exc_info=True)
    except Exception:
        _log.debug("profile enablement sweep skipped", exc_info=True)
    return healed
