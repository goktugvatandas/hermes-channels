import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def _run(home: Path, *args: str):
    env = {**os.environ, "HERMES_HOME": str(home)}
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "install.py"), *args],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def test_install_is_idempotent_and_preserves_owner_data(tmp_path):
    home = tmp_path / "owner"
    home.mkdir()
    (home / "config.yaml").write_text(
        "model:\n  provider: openai\nplugins:\n  enabled:\n    - existing\n",
        encoding="utf-8",
    )
    member = home / "profiles" / "atlas"
    member.mkdir(parents=True)
    sentinel = member / "SOUL.md"
    sentinel.write_text("Atlas", encoding="utf-8")
    data = home / "crew" / "crew.db"
    data.parent.mkdir()
    data.write_bytes(b"existing-data")

    first = _run(home)
    second = _run(home)

    assert "Restart or reload Hermes Desktop" in first.stdout
    assert second.returncode == 0
    assert (home / "desktop-plugins" / "hermes-crew" / "plugin.js").is_file()
    assert (home / "plugins" / "hermes-crew" / "dashboard" / "plugin_api.py").is_file()
    assert (home / "plugins" / "hermes-crew" / "dashboard" / "dist" / "index.js").is_file()
    assert (home / "plugins" / "hermes-crew" / "dashboard" / "hermes_crew_backend" / "api.py").is_file()
    config = (home / "config.yaml").read_text(encoding="utf-8")
    assert config.count("- existing") == 1
    assert config.count("- hermes-crew") == 1
    assert data.read_bytes() == b"existing-data"
    assert sentinel.read_text(encoding="utf-8") == "Atlas"

    _run(home, "--uninstall")
    assert not (home / "desktop-plugins" / "hermes-crew").exists()
    assert not (home / "plugins" / "hermes-crew").exists()
    assert data.read_bytes() == b"existing-data"
