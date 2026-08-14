"""Hermes Channels plugin entry point.

Crew exposes no agent-visible tools or hooks; its one host-side registration
is the ``channels`` messaging platform, which makes crew channels first-class
send targets (agent ``send_message``, ``hermes send --to channels:<channel>``,
cron ``deliver=channels``) and lists them in the host channel directory.
"""


def register(ctx):
    register_platform = getattr(ctx, "register_platform", None)
    if register_platform is None:
        return None  # Pre-platform-registry host: Crew still works, just unlisted.
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
