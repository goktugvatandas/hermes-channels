from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "dist" / "desktop-plugins" / "hermes-channels" / "plugin.js"
DASHBOARD_PLUGIN = ROOT / "dist" / "plugins" / "hermes-channels" / "dashboard" / "dist" / "index.js"
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


def test_desktop_bundle_is_native_esm_without_dynamic_require():
    subprocess.run(
        ["node", str(ROOT / "scripts" / "build.mjs")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    source = PLUGIN.read_text(encoding="utf-8")

    assert "Dynamic require of" not in source
    assert not re.search(r"\b__require\s*\(", source)


def test_bundle_contains_a_self_registering_dashboard_entry():
    subprocess.run(
        ["node", str(ROOT / "scripts" / "build.mjs")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    source = DASHBOARD_PLUGIN.read_text(encoding="utf-8")

    assert "__HERMES_PLUGIN_SDK__" in source
    assert '__HERMES_PLUGINS__.register("hermes-channels"' in source
    assert not re.search(r"(?:^|\n)\s*(?:import|export)\s", source)
