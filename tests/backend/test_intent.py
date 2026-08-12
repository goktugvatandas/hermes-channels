from hermes_crew_backend.intent import parse_agent_output


def test_marker_is_removed_from_visible_text():
    """Valid routing metadata must never be displayed as message prose."""
    raw = 'Done.\n<!-- hermes-crew:intent {"schemaVersion":1,"intent":"inform"} -->'

    visible, envelope = parse_agent_output(raw)

    assert visible == "Done."
    assert envelope.intent == "inform"


def test_multiple_markers_fall_back_to_non_triggering_inform():
    """Conflicting hidden commands must not wake another agent."""
    raw = """Draft.
<!-- hermes-crew:intent {"schemaVersion":1,"intent":"review_request","recipients":["critic"],"replyExpected":true} -->
Final.
<!-- hermes-crew:intent {"schemaVersion":1,"intent":"handoff","recipients":["atlas"],"replyExpected":true} -->"""

    visible, envelope = parse_agent_output(raw)

    assert visible == "Draft.\n\nFinal."
    assert envelope.intent == "inform"
    assert envelope.recipients == []


def test_oversized_marker_falls_back_without_exposing_the_comment():
    """An oversized model-authored payload must be stripped and ignored."""
    raw = (
        "Visible\n<!-- hermes-crew:intent "
        + '{"schemaVersion":1,"summary":"'
        + ("x" * 4096)
        + '"} -->'
    )

    visible, envelope = parse_agent_output(raw)

    assert visible == "Visible"
    assert envelope.intent == "inform"
