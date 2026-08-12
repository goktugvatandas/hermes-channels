"""Narrow profile-aware bridge to Hermes Agent 0.20.0 public modules."""

from contextlib import contextmanager
import importlib
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

from .models import ProjectRef


def _load_bindings() -> SimpleNamespace:
    """Import Hermes lazily so the Crew package remains testable in isolation."""

    profiles = importlib.import_module("hermes_cli.profiles")
    constants = importlib.import_module("hermes_constants")
    config = importlib.import_module("hermes_cli.config")
    projects = importlib.import_module("hermes_cli.projects_db")
    utils = importlib.import_module("utils")
    skills = importlib.import_module("hermes_cli.skills_config")
    tools = importlib.import_module("hermes_cli.tools_config")
    return SimpleNamespace(
        list_profiles=profiles.list_profiles,
        create_profile=profiles.create_profile,
        rename_profile=profiles.rename_profile,
        delete_profile=profiles.delete_profile,
        write_profile_meta=profiles.write_profile_meta,
        get_profile_dir=profiles.get_profile_dir,
        set_home_override=constants.set_hermes_home_override,
        reset_home_override=constants.reset_hermes_home_override,
        load_config=config.load_config,
        save_config=config.save_config,
        atomic_write_text=utils.atomic_write_text,
        get_disabled_skills=skills.get_disabled_skills,
        save_disabled_skills=skills.save_disabled_skills,
        get_platform_tools=tools._get_platform_tools,
        save_platform_tools=tools._save_platform_tools,
        connect_projects=projects.connect,
        list_projects=projects.list_projects,
        get_project=projects.get_project,
    )


class HermesAdapter:
    """Expose only the Hermes-owned state Hermes Crew is allowed to manage."""

    def __init__(self, bindings: Any | None = None):
        self._bindings = bindings

    @property
    def bindings(self) -> Any:
        if self._bindings is None:
            self._bindings = _load_bindings()
        return self._bindings

    def _profile_path(self, name: str) -> Path:
        path = Path(self.bindings.get_profile_dir(name))
        if not path.is_dir():
            raise KeyError(f"unknown Hermes profile: {name}")
        return path

    @contextmanager
    def _scope(self, name: str) -> Iterator[Path]:
        path = self._profile_path(name)
        token = self.bindings.set_home_override(path)
        try:
            yield path
        finally:
            self.bindings.reset_home_override(token)

    def list_profiles(self) -> list[dict[str, Any]]:
        return [self._profile_payload(info) for info in self.bindings.list_profiles()]

    def get_profile(self, name: str) -> dict[str, Any]:
        for profile in self.list_profiles():
            if profile["name"] == name:
                return profile
        raise KeyError(f"unknown Hermes profile: {name}")

    def create_profile(
        self,
        name: str,
        *,
        no_skills: bool = False,
        clone_from: str | None = None,
        clone_config: bool = False,
        clone_all: bool = False,
        description: str | None = None,
    ) -> dict[str, Any]:
        if no_skills and (clone_from or clone_config or clone_all):
            raise ValueError("no_skills and clone options are mutually exclusive")
        self.bindings.create_profile(
            name,
            clone_from=clone_from,
            clone_all=clone_all,
            clone_config=clone_config,
            no_alias=True,
            no_skills=no_skills,
            description=description,
        )
        return self.get_profile(name)

    def update_profile(
        self, name: str, *, description: str | None = None
    ) -> dict[str, Any]:
        path = self._profile_path(name)
        if description is not None:
            self.bindings.write_profile_meta(
                path, description=description, description_auto=False
            )
        return self.get_profile(name)

    def read_soul(self, name: str) -> str:
        path = self._profile_path(name) / "SOUL.md"
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def write_soul(self, name: str, content: str) -> str:
        path = self._profile_path(name) / "SOUL.md"
        self.bindings.atomic_write_text(
            path,
            content,
            encoding="utf-8",
            preserve_mode=True,
            create_mode=0o644,
        )
        return content

    def set_model(self, name: str, *, provider: str, model: str) -> dict[str, Any]:
        normalized_provider = provider.strip()
        normalized_model = model.strip()
        if not normalized_provider or not normalized_model:
            raise ValueError("provider and model are required")
        with self._scope(name):
            config = self.bindings.load_config()
            previous = config.get("model")
            config["model"] = {
                **(previous if isinstance(previous, dict) else {}),
                "provider": normalized_provider,
                "default": normalized_model,
            }
            config["model"].pop("base_url", None)
            config["model"].pop("context_length", None)
            self.bindings.save_config(config)
        return self.get_profile(name)

    def list_skills(self, name: str) -> list[dict[str, Any]]:
        with self._scope(name) as path:
            config = self.bindings.load_config()
            disabled = self.bindings.get_disabled_skills(config)
            installed = sorted(
                {
                    skill_file.parent.name
                    for skill_file in (path / "skills").rglob("SKILL.md")
                }
            )
        return [
            {"name": skill_name, "enabled": skill_name not in disabled}
            for skill_name in installed
        ]

    def set_skills(self, name: str, *, enabled: list[str]) -> list[dict[str, Any]]:
        installed = {item["name"] for item in self.list_skills(name)}
        requested = {value.strip() for value in enabled if value.strip()}
        unknown = requested - installed
        if unknown:
            raise ValueError(f"unknown installed skills: {sorted(unknown)}")
        with self._scope(name):
            config = self.bindings.load_config()
            disabled = set(self.bindings.get_disabled_skills(config))
            disabled -= installed
            disabled |= installed - requested
            self.bindings.save_disabled_skills(config, disabled)
        return self.list_skills(name)

    def list_toolsets(self, name: str) -> list[str]:
        with self._scope(name):
            config = self.bindings.load_config()
            enabled = self.bindings.get_platform_tools(
                config, "cli", include_default_mcp_servers=False
            )
        return sorted(str(value) for value in enabled)

    def set_toolsets(self, name: str, *, enabled: list[str]) -> list[str]:
        requested = {value.strip() for value in enabled if value.strip()}
        with self._scope(name):
            config = self.bindings.load_config()
            self.bindings.save_platform_tools(config, "cli", requested)
        return self.list_toolsets(name)

    def list_projects(self, name: str) -> list[dict[str, Any]]:
        with self._scope(name):
            connection = self.bindings.connect_projects()
            try:
                projects = self.bindings.list_projects(connection)
                return [self._project_payload(project) for project in projects]
            finally:
                connection.close()

    def validate_project(
        self, name: str, project_id: str, cwd: str | None = None
    ) -> ProjectRef:
        with self._scope(name):
            connection = self.bindings.connect_projects()
            try:
                project = self.bindings.get_project(connection, project_id)
            finally:
                connection.close()
        if project is None or bool(getattr(project, "archived", False)):
            raise ValueError(f"unknown active project: {project_id}")
        primary = getattr(project, "primary_path", None)
        if not primary:
            primary_folder = next(
                (
                    folder.path
                    for folder in getattr(project, "folders", [])
                    if getattr(folder, "is_primary", False)
                ),
                None,
            )
            primary = primary_folder
        if not primary:
            raise ValueError("project has no primary cwd")
        canonical_primary = os.path.normpath(str(primary))
        if cwd is not None and os.path.normpath(cwd) != canonical_primary:
            raise ValueError("project cwd does not match its primary cwd")
        return ProjectRef(
            mode="project",
            profile=name,
            project_id=str(project.id),
            label=str(project.name),
            cwd=canonical_primary,
        )

    @staticmethod
    def _profile_payload(info: Any) -> dict[str, Any]:
        return {
            "name": str(info.name),
            "path": str(info.path),
            "isDefault": bool(info.is_default),
            "gatewayRunning": bool(info.gateway_running),
            "model": info.model,
            "provider": info.provider,
            "hasEnv": bool(info.has_env),
            "skillCount": int(info.skill_count),
            "description": str(getattr(info, "description", "") or ""),
            "descriptionAuto": bool(getattr(info, "description_auto", False)),
        }

    @staticmethod
    def _project_payload(project: Any) -> dict[str, Any]:
        payload = project.to_dict()
        return {
            "id": payload["id"],
            "slug": payload["slug"],
            "name": payload["name"],
            "primaryPath": payload.get("primary_path"),
            "archived": bool(payload.get("archived", False)),
            "folders": [
                {
                    "path": folder["path"],
                    "label": folder.get("label"),
                    "isPrimary": bool(folder.get("is_primary", False)),
                }
                for folder in payload.get("folders", [])
            ],
        }
