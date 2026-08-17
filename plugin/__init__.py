"""Hermes Channels plugin entry point.

The Python half registers the ``channels`` messaging platform plus host-owned
agent lifecycle hooks. The hooks make channel completion durable inside the
agent process; the Desktop plugin remains responsible for live progress and a
compatibility completion fallback.
"""

from pathlib import Path
import sys


def _ensure_backend_importable() -> None:
    dashboard = str(Path(__file__).resolve().parent / "dashboard")
    if dashboard not in sys.path:
        sys.path.insert(0, dashboard)


def register(ctx):
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is not None:
        _ensure_backend_importable()
        from hermes_channels_backend.card_references import (
            annotate_kanban_tool_result,
            translate_kanban_tool_args,
        )
        from hermes_channels_backend.turn_hooks import (
            on_channel_session_end,
            on_channel_stream_boundary,
            persist_channel_response,
        )

        register_hook("post_llm_call", persist_channel_response)
        register_hook("on_session_end", on_channel_session_end)
        register_hook("on_stream_start", on_channel_stream_boundary)
        register_hook("on_stream_end", on_channel_stream_boundary)
        register_hook("transform_tool_result", annotate_kanban_tool_result)
        register_hook("pre_tool_call", translate_kanban_tool_args)

    register_platform = getattr(ctx, "register_platform", None)
    if register_platform is None:
        return None  # Pre-platform-registry host: lifecycle hooks still work.
    from . import platform_adapter

    register_platform(
        name=platform_adapter.PLATFORM_NAME,
        label="Channels",
        adapter_factory=platform_adapter.make_adapter,
        check_fn=platform_adapter.check_requirements,
        install_hint="Install Hermes Channels first — its channels.db workspace was not found.",
        env_enablement_fn=platform_adapter.env_enablement,
        parse_target_ref_fn=platform_adapter.parse_target_ref,
        cron_deliver_env_var=platform_adapter.HOME_CHANNEL_ENV,
        standalone_sender_fn=platform_adapter.standalone_send,
    )
    return None
