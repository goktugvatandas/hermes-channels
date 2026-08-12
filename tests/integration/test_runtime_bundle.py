from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "dist" / "desktop-plugins" / "hermes-crew" / "plugin.js"
ALLOWED_IMPORTS = {
    "@hermes/plugin-sdk",
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
}


def test_bundle_passes_hermes_0_20_runtime_import_scanner():
    subprocess.run(
        ["node", str(ROOT / "scripts" / "build.mjs")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    source = PLUGIN.read_text(encoding="utf-8")
    runtime_imports = re.findall(
        r"(?:from\s*|import\s*\(\s*|import\s+)(['\"])([^'\"]+)\1",
        source,
    )
    unsupported = [
        specifier
        for _, specifier in runtime_imports
        if specifier not in ALLOWED_IMPORTS
    ]

    assert unsupported == []
