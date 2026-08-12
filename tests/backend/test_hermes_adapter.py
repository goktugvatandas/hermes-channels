from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_crew_backend.hermes_adapter import HermesAdapter


@dataclass
class FakeProfile:
    name: str
    path: Path
    is_default: bool = False
    gateway_running: bool = False
    model: str | None = None
    provider: str | None = None
    has_env: bool = False
    skill_count: int = 0
    description: str = ""
    description_auto: bool = False


@dataclass
class FakeFolder:
    path: str
    is_primary: bool = False


@dataclass
class FakeProject:
    id: str
    slug: str
    name: str
    primary_path: str
    archived: bool = False
    folders: list[FakeFolder] = field(default_factory=list)

    def to_dict(self):
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "primary_path": self.primary_path,
            "archived": self.archived,
            "folders": [vars(folder) for folder in self.folders],
        }


class FakeHermes:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir()
        (root / "skills" / "base").mkdir(parents=True)
        (root / "skills" / "base" / "SKILL.md").write_text("# Base")
        self.current = root
        self.configs = {
            root: {"model": {"provider": "local", "default": "default-model"}}
        }
        self.created: list[dict] = []
        self.projects: dict[Path, list[FakeProject]] = {}

    def profile_dir(self, name: str) -> Path:
        return self.root if name == "default" else self.root / "profiles" / name

    def list_profiles(self):
        result = [FakeProfile("default", self.root, is_default=True, has_env=True)]
        profiles = self.root / "profiles"
        if profiles.exists():
            for path in sorted(profiles.iterdir()):
                cfg = self.configs.get(path, {})
                model = cfg.get("model", {})
                result.append(
                    FakeProfile(
                        path.name,
                        path,
                        model=model.get("default"),
                        provider=model.get("provider"),
                        has_env=(path / ".env").exists(),
                        skill_count=len(list((path / "skills").rglob("SKILL.md"))),
                    )
                )
        return result

    def create_profile(self, name: str, **kwargs):
        self.created.append({"name": name, **kwargs})
        path = self.profile_dir(name)
        (path / "skills").mkdir(parents=True)
        self.configs[path] = {}
        return path

    def set_override(self, path):
        old = self.current
        self.current = Path(path)
        return old

    def reset_override(self, token):
        self.current = token

    def load_config(self):
        return self.configs.setdefault(self.current, {}).copy()

    def save_config(self, config):
        self.configs[self.current] = config

    def atomic_write(self, path, content, **kwargs):
        Path(path).write_text(content)

    def get_disabled(self, config):
        return set(config.get("skills", {}).get("disabled", []))

    def save_disabled(self, config, disabled):
        config.setdefault("skills", {})["disabled"] = sorted(disabled)
        self.save_config(config)

    def get_tools(self, config, platform, **kwargs):
        return set(config.get("platform_toolsets", {}).get(platform, []))

    def save_tools(self, config, platform, enabled):
        config.setdefault("platform_toolsets", {})[platform] = sorted(enabled)
        self.save_config(config)

    def connect_projects(self):
        return SimpleNamespace(close=lambda: None)

    def list_projects(self, _connection):
        return self.projects.get(self.current, [])

    def get_project(self, _connection, project_id):
        return next(
            (project for project in self.projects.get(self.current, []) if project.id == project_id),
            None,
        )

    def bindings(self):
        return SimpleNamespace(
            list_profiles=self.list_profiles,
            create_profile=self.create_profile,
            rename_profile=lambda old, new: None,
            delete_profile=lambda name, yes=False: None,
            write_profile_meta=lambda path, **kwargs: None,
            get_profile_dir=self.profile_dir,
            set_home_override=self.set_override,
            reset_home_override=self.reset_override,
            load_config=self.load_config,
            save_config=self.save_config,
            atomic_write_text=self.atomic_write,
            get_disabled_skills=self.get_disabled,
            save_disabled_skills=self.save_disabled,
            get_platform_tools=self.get_tools,
            save_platform_tools=self.save_tools,
            connect_projects=self.connect_projects,
            list_projects=self.list_projects,
            get_project=self.get_project,
        )


def test_create_profile_and_soul_are_scoped_to_the_named_member(tmp_path):
    """Creating Atlas must not write SOUL or profile state into Scout/default."""
    fake = FakeHermes(tmp_path / "hermes")
    adapter = HermesAdapter(fake.bindings())

    atlas = adapter.create_profile("atlas", no_skills=True, description="Engineer")
    adapter.write_soul("atlas", "You are Atlas.\n")

    assert atlas["name"] == "atlas"
    assert fake.created == [
        {
            "name": "atlas",
            "clone_from": None,
            "clone_all": False,
            "clone_config": False,
            "no_alias": True,
            "no_skills": True,
            "description": "Engineer",
        }
    ]
    assert adapter.read_soul("atlas") == "You are Atlas.\n"
    assert not (fake.root / "SOUL.md").exists()


def test_models_skills_and_toolsets_remain_independent_per_profile(tmp_path):
    """Atlas/OpenAI changes must never alter Scout/Gemini capabilities."""
    fake = FakeHermes(tmp_path / "hermes")
    adapter = HermesAdapter(fake.bindings())
    for name in ("atlas", "scout"):
        adapter.create_profile(name, no_skills=True)
        for skill in ("github", "research"):
            directory = fake.profile_dir(name) / "skills" / skill
            directory.mkdir()
            (directory / "SKILL.md").write_text(f"# {skill}")

    adapter.set_model("atlas", provider="openai", model="gpt-5.6")
    adapter.set_model("scout", provider="google", model="gemini-3")
    adapter.set_skills("atlas", enabled=["github"])
    adapter.set_toolsets("atlas", enabled=["terminal", "browser"])

    assert adapter.get_profile("atlas")["model"] == "gpt-5.6"
    assert adapter.get_profile("scout")["model"] == "gemini-3"
    assert {item["name"]: item["enabled"] for item in adapter.list_skills("atlas")} == {
        "github": True,
        "research": False,
    }
    assert {item["name"]: item["enabled"] for item in adapter.list_skills("scout")} == {
        "github": True,
        "research": True,
    }
    assert adapter.list_toolsets("atlas") == ["browser", "terminal"]
    assert adapter.list_toolsets("scout") == []
    assert "base_url" not in fake.configs[fake.profile_dir("atlas")]["model"]


def test_projects_are_validated_by_profile_id_and_primary_cwd(tmp_path):
    """A project reference must match the selected profile and canonical cwd."""
    fake = FakeHermes(tmp_path / "hermes")
    adapter = HermesAdapter(fake.bindings())
    adapter.create_profile("atlas", no_skills=True)
    web = FakeProject(
        "p_web",
        "web",
        "Web",
        "/work/web",
        folders=[FakeFolder("/work/web", is_primary=True)],
    )
    fake.projects[fake.profile_dir("atlas")] = [web]

    assert adapter.list_projects("atlas")[0]["id"] == "p_web"
    resolved = adapter.validate_project("atlas", "p_web", "/work/tmp/../web")
    assert resolved.project_id == "p_web"
    assert resolved.cwd == "/work/web"
    with pytest.raises(ValueError, match="cwd"):
        adapter.validate_project("atlas", "p_web", "/work/other")


def test_profile_payload_exposes_env_readiness_without_secret_values(tmp_path):
    """Studio may report credential presence but must never return .env content."""
    fake = FakeHermes(tmp_path / "hermes")
    fake.create_profile("atlas", no_skills=True)
    (fake.profile_dir("atlas") / ".env").write_text("OPENAI_API_KEY=super-secret")
    adapter = HermesAdapter(fake.bindings())

    payload = adapter.get_profile("atlas")

    assert payload["hasEnv"] is True
    assert "super-secret" not in repr(payload)
