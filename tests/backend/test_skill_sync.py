"""Per-profile sync of the channel-collaboration skill."""

from hermes_channels_backend.profile_enablement import (
    sync_collaboration_skill,
    sync_plugin_bundle,
)


def _seed(home, version="1.3.0", body="guide text"):
    source = home / "skills" / "hermes-channels" / "channel-collaboration" / "SKILL.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(
        f"---\nname: channel-collaboration\nversion: {version}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return source


def test_sync_copies_missing_skill_into_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed(tmp_path)
    profile = tmp_path / "profiles" / "atlas"
    profile.mkdir(parents=True)

    assert sync_collaboration_skill(profile) is True
    copy = profile / "skills" / "channel-collaboration" / "SKILL.md"
    assert "guide text" in copy.read_text(encoding="utf-8")
    # Same version again: untouched, so local edits survive.
    copy.write_text(copy.read_text(encoding="utf-8") + "\nlocal note\n", encoding="utf-8")
    assert sync_collaboration_skill(profile) is False
    assert "local note" in copy.read_text(encoding="utf-8")


def test_sync_replaces_outdated_copy(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed(tmp_path, version="1.4.0", body="newer guide")
    profile = tmp_path / "profiles" / "forge"
    stale = profile / "skills" / "channel-collaboration" / "SKILL.md"
    stale.parent.mkdir(parents=True)
    stale.write_text("---\nversion: 1.3.0\n---\nold guide\n", encoding="utf-8")

    assert sync_collaboration_skill(profile) is True
    assert "newer guide" in stale.read_text(encoding="utf-8")


def test_sync_is_a_noop_without_an_installed_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    profile = tmp_path / "profiles" / "muse"
    profile.mkdir(parents=True)
    assert sync_collaboration_skill(profile) is False
    assert not (profile / "skills").exists()


def _seed_plugin(home, version="0.3.3", body="hook code"):
    source = home / "plugins" / "hermes-channels"
    source.mkdir(parents=True)
    (source / "plugin.yaml").write_text(
        f'name: hermes-channels\nversion: "{version}"\n', encoding="utf-8"
    )
    (source / "__init__.py").write_text(body, encoding="utf-8")
    backend = source / "dashboard" / "hermes_channels_backend"
    backend.mkdir(parents=True)
    (backend / "turn_hooks.py").write_text("DURABLE = True\n", encoding="utf-8")
    return source


def test_sync_copies_owner_plugin_into_profile_for_profile_scoped_hooks(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed_plugin(tmp_path)
    profile = tmp_path / "profiles" / "atlas"
    profile.mkdir(parents=True)

    assert sync_plugin_bundle(profile) is True
    copy = profile / "plugins" / "hermes-channels"
    assert (copy / "dashboard" / "hermes_channels_backend" / "turn_hooks.py").is_file()
    assert (copy / "__init__.py").read_text(encoding="utf-8") == "hook code"

    # A same-version profile copy is left untouched so local edits survive.
    (copy / "__init__.py").write_text("local hook edit", encoding="utf-8")
    assert sync_plugin_bundle(profile) is False
    assert (copy / "__init__.py").read_text(encoding="utf-8") == "local hook edit"


def test_sync_replaces_an_outdated_profile_plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _seed_plugin(tmp_path, version="0.3.3", body="new hook code")
    profile = tmp_path / "profiles" / "forge"
    stale = profile / "plugins" / "hermes-channels"
    stale.mkdir(parents=True)
    (stale / "plugin.yaml").write_text(
        'name: hermes-channels\nversion: "0.3.2"\n', encoding="utf-8"
    )
    (stale / "__init__.py").write_text("old hook code", encoding="utf-8")

    assert sync_plugin_bundle(profile) is True
    assert (stale / "__init__.py").read_text(encoding="utf-8") == "new hook code"
