import pytest


@pytest.fixture(autouse=True)
def _isolated_hermes_home(tmp_path_factory, monkeypatch):
    """Service load() sweeps $HERMES_HOME (profile enablement, session
    archives); tests must never touch the developer's real home."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path_factory.mktemp("hermes-home")))
