"""Crew Schedules wrap Hermes cron jobs with script-based channel posts."""

import json
import re
from pathlib import Path

import pytest

from hermes_crew_backend.schedules import ORIGIN, Schedules


class FakeCronJobs:
    """Mimics cron.jobs' shapes: id, origin, script, schedule dict, states."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.counter = 0
        self.notified = 0

    def parse_schedule(self, value: str) -> dict:
        if not re.match(r"^(every \d+[mh]|(\S+\s+){4}\S+)$", value):
            raise ValueError(f"unrecognized schedule: {value}")
        return {"kind": "cron", "display": value}

    def create_job(self, *, prompt, schedule, name, deliver, origin, script, no_agent):
        self.counter += 1
        job = {
            "id": f"job{self.counter:03d}",
            "name": name,
            "origin": origin,
            "script": script,
            "no_agent": no_agent,
            "deliver": deliver,
            "schedule": self.parse_schedule(schedule),
            "enabled": True,
            "state": "scheduled",
            "next_run_at": 111,
            "last_run_at": None,
            "last_status": None,
        }
        self.jobs[job["id"]] = job
        return job

    def list_jobs(self, include_disabled=False):
        return list(self.jobs.values())

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def remove_job(self, job_id):
        return self.jobs.pop(job_id, None) is not None

    def pause_job(self, job_id):
        self.jobs[job_id]["state"] = "paused"
        return self.jobs[job_id]

    def resume_job(self, job_id):
        self.jobs[job_id]["state"] = "scheduled"
        return self.jobs[job_id]

    def trigger_job(self, job_id):
        self.jobs[job_id]["next_run_at"] = 0
        return self.jobs[job_id]


@pytest.fixture()
def schedules(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    fake = FakeCronJobs()
    notify = lambda: setattr(fake, "notified", fake.notified + 1)  # noqa: E731
    return fake, Schedules(tmp_path / "crew.db", bindings=(fake, notify))


def test_create_writes_script_and_registers_origin_tagged_job(schedules, tmp_path):
    fake, store = schedules
    created = store.create(
        name="Morning standup",
        schedule="0 9 * * 1-5",
        channel_id="chan-1",
        content="@Odin kick off the standup",
        mentions=["default"],
    )

    assert created["name"] == "Morning standup"
    assert created["channelId"] == "chan-1"
    assert created["mentions"] == ["default"]
    job = fake.jobs[created["id"]]
    assert job["origin"] == ORIGIN and job["no_agent"] is True
    script = Path(job["script"])
    assert script.exists() and script.parent == Path(tmp_path / "home" / "scripts")
    body = script.read_text()
    assert "hermes_crew_backend" in body and "@Odin kick off the standup" in body
    assert fake.notified == 1

    # Listing surfaces only crew-origin jobs, with the payload decoded back.
    fake.jobs["alien"] = {"id": "alien", "origin": "user", "schedule": {}}
    listed = store.list()
    assert [item["id"] for item in listed] == [created["id"]]
    assert listed[0]["content"] == "@Odin kick off the standup"


def test_bad_cadence_fails_fast_without_leaving_scripts(schedules, tmp_path):
    fake, store = schedules
    with pytest.raises(ValueError):
        store.create(
            name="broken", schedule="whenever", channel_id="c", content="x", mentions=[]
        )
    scripts = Path(tmp_path / "home" / "scripts")
    assert not scripts.exists() or not list(scripts.iterdir())
    assert fake.jobs == {}


def test_remove_deletes_job_and_script_and_guards_foreign_jobs(schedules):
    fake, store = schedules
    created = store.create(
        name="cleanup", schedule="every 30m", channel_id="c", content="x", mentions=[]
    )
    script = Path(fake.jobs[created["id"]]["script"])
    assert store.remove(created["id"]) is True
    assert not script.exists() and created["id"] not in fake.jobs

    fake.jobs["foreign"] = {"id": "foreign", "origin": "user"}
    with pytest.raises(KeyError):
        store.remove("foreign")


def test_pause_resume_trigger_roundtrip(schedules):
    fake, store = schedules
    created = store.create(
        name="pulse", schedule="every 30m", channel_id="c", content="x", mentions=[]
    )
    paused = store.set_paused(created["id"], True)
    assert paused["enabled"] is False and paused["state"] == "paused"
    resumed = store.set_paused(created["id"], False)
    assert resumed["enabled"] is True
    triggered = store.trigger(created["id"])
    assert triggered["nextRunAt"] == 0


def test_generated_script_posts_through_real_routing(schedules, tmp_path):
    """Execute the generated script end-to-end against a real crew.db."""
    import subprocess
    import sys

    fake, store = schedules
    # Real database with a channel + member so routing has something to do.
    sys.path.insert(0, "src/backend")
    from hermes_crew_backend.db import CrewDatabase
    from hermes_crew_backend.repositories import CrewRepository

    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", default_responder_profile="atlas")
    repo.add_member(channel.id, "atlas", activation_policy="always")

    created = store.create(
        name="standup",
        schedule="every 30m",
        channel_id=channel.id,
        content="Daily standup: @atlas summarize progress.",
        mentions=["atlas"],
    )
    script = Path(fake.jobs[created["id"]]["script"])
    # The generated script points at the installed plugin dir; for the test,
    # point it at the repo's backend package instead.
    body = script.read_text().replace(
        script.read_text().split("sys.path.insert(0, ")[1].split(")")[0],
        repr(str(Path("src/backend").resolve())),
    )
    script.write_text(body)

    result = subprocess.run(
        [sys.executable, str(script)], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["turns"] == ["atlas"]
    messages = repo.list_channel_messages(channel.id)
    assert any("Daily standup" in message.content for message in messages)
