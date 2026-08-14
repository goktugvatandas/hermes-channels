"""Hermes dashboard backend loader for the packaged Crew API."""

from pathlib import Path
import sys


PLUGIN_DIR = Path(__file__).resolve().parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

from hermes_channels_backend.api import router  # noqa: E402

__all__ = ["router"]
