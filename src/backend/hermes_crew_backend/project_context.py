"""Project inheritance and session-scope resolution."""

import os

from .models import ProjectRef
from .repositories import CrewRepository


def resolve_project_context(
    repo: CrewRepository,
    channel_id: str,
    message_id: str,
    *,
    target_profile: str | None = None,
) -> ProjectRef:
    message = repo.require_message(message_id)
    if message.channel_id != channel_id:
        raise ValueError("message does not belong to the target channel")
    root = (
        repo.require_message(message.root_message_id)
        if message.root_message_id
        else message
    )
    channel = repo.require_channel(channel_id)
    for candidate in (message.project, root.project, channel.default_project):
        if candidate is not None and candidate.mode != "inherit":
            return candidate
    selected_profile = target_profile or message.target_profile
    member_default = (
        repo.member_default_project(selected_profile) if selected_profile else None
    )
    return member_default or ProjectRef(mode="global")


def resolve_scope_id(repo: CrewRepository, channel_id: str, message_id: str) -> str:
    """Return the durable session scope for a channel message."""

    message = repo.require_message(message_id)
    if message.channel_id != channel_id:
        raise ValueError("message does not belong to the target channel")
    if message.root_message_id:
        return message.root_message_id
    if message.project is not None and message.project.mode != "inherit":
        return message.id
    return channel_id


def project_key(project: ProjectRef) -> str:
    if project.mode == "global":
        return "global"
    if project.mode != "project":
        raise ValueError("project key requires resolved context")
    assert project.profile is not None
    assert project.project_id is not None
    assert project.cwd is not None
    return f"{project.profile}:{project.project_id}:{os.path.normpath(project.cwd)}"
