from hermes_crew_backend.classifier import Classifier
from hermes_crew_backend.db import CrewDatabase
from hermes_crew_backend.repositories import CrewRepository


def test_classifier_is_not_scheduled_when_disabled(tmp_path):
    """The default routing path must not spend a separate model call."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    message = repo.append_message(channel.id, "user", "who should handle this?")

    assert Classifier(repo).plan(message.id) is None


def test_classifier_rejects_unknown_members_and_low_confidence(tmp_path):
    """Classifier output must neither widen membership nor route uncertainty."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general")
    repo.add_member(channel.id, "atlas")
    classifier = Classifier(repo)

    assert (
        classifier.parse_result(
            '{"intent":"question","recipients":["outsider"],"confidence":0.9}',
            channel.id,
        )
        is None
    )
    assert (
        classifier.parse_result(
            '{"intent":"question","recipients":["atlas"],"confidence":0.4}',
            channel.id,
        )
        is None
    )


def test_enabled_classifier_claim_is_snapshotted_once_before_dispatch(tmp_path):
    """A restart or duplicate planner pass must reuse one durable classifier turn."""
    repo = CrewRepository(CrewDatabase(tmp_path / "crew.db"))
    channel = repo.create_channel("general", purpose="Route requests")
    repo.add_member(channel.id, "atlas")
    message = repo.append_message(channel.id, "user", "route this")
    classifier = Classifier(repo)
    classifier.configure(
        channel.id,
        enabled=True,
        provider="openai",
        model="gpt-classifier",
        reasoning_effort="low",
        max_tokens=250,
    )

    first = classifier.plan(message.id)
    duplicate = classifier.plan(message.id)

    assert first is not None
    assert duplicate == first
    assert "approval_request" in first.instructions
    assert "Route requests" in first.input
    with repo.database.connect() as connection:
        rows = connection.execute(
            "SELECT kind, state, provider, model, reasoning_effort FROM turns"
        ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("classification", "queued", "openai", "gpt-classifier", "low")
    ]
