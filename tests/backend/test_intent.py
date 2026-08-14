from hermes_channels_backend.intent import parse_agent_output


def test_marker_is_removed_from_visible_text():
    """Valid routing metadata must never be displayed as message prose."""
    raw = 'Done.\n<!-- hermes-channels:intent {"schemaVersion":1,"intent":"inform"} -->'

    visible, envelope = parse_agent_output(raw)

    assert visible == "Done."
    assert envelope.intent == "inform"


def test_multiple_markers_merge_into_one_scheduling_envelope():
    """Models emit one marker per delegation plus a wrap-up; markers merge
    (recipients union, strongest scheduling intent, max budget) instead of
    being discarded — the old take-none rule silently dropped every real
    handoff."""
    raw = """Draft.
<!-- hermes-channels:intent {"schemaVersion":1,"intent":"review_request","recipients":["critic"],"replyExpected":true,"replyBudget":2} -->
Final.
<!-- hermes-channels:intent {"schemaVersion":1,"intent":"handoff","recipients":["atlas"],"replyExpected":true,"replyBudget":1,"placement":"thread"} -->
[[hermes-channels:intent {"schemaVersion":1,"intent":"inform","summary":"delegations sent"}]]"""

    visible, envelope = parse_agent_output(raw)

    assert visible == "Draft.\n\nFinal."
    assert envelope.intent == "handoff"
    assert list(envelope.recipients) == ["critic", "atlas"]
    assert envelope.reply_expected is True
    assert envelope.reply_budget == 2
    assert envelope.placement == "thread"
    assert envelope.summary == "delegations sent"


def test_oversized_marker_falls_back_without_exposing_the_comment():
    """An oversized model-authored payload must be stripped and ignored."""
    raw = (
        "Visible\n<!-- hermes-channels:intent "
        + '{"schemaVersion":1,"summary":"'
        + ("x" * 4096)
        + '"} -->'
    )

    visible, envelope = parse_agent_output(raw)

    assert visible == "Visible"
    assert envelope.intent == "inform"


def test_bracket_marker_form_parses_and_strips():
    """The gateway sanitizes HTML comments out of message frames, so the
    canonical marker is plain text; both forms must parse and strip."""
    from hermes_channels_backend.intent import parse_agent_output

    raw = (
        'Handing off.\n'
        '[[hermes-channels:intent {"schemaVersion":1,"intent":"handoff",'
        '"recipients":["freya"],"replyExpected":true,"replyBudget":1}]]'
    )
    visible, envelope = parse_agent_output(raw)
    assert visible == 'Handing off.'
    assert envelope.intent == 'handoff'
    assert list(envelope.recipients) == ['freya']


def test_strip_tolerates_truncated_marker_closer():
    """Models sometimes emit `}]` instead of `}]]` — the marker line must
    still disappear from displayable/context text."""
    from hermes_channels_backend.intent import parse_agent_output

    text = (
        "All done.\n\n"
        '[[hermes-channels:intent {"schemaVersion":1,"intent":"inform","summary":"x"}]'
    )
    visible, envelope = parse_agent_output(text)
    assert visible == "All done."
    assert envelope.intent == "inform"  # falls back to default when malformed


def test_strip_removes_multiline_marker_bodies():
    """The exact form may pretty-print JSON across lines; display text must
    not start mid-JSON."""
    from hermes_channels_backend.intent import parse_agent_output

    text = (
        "Done.\n\n"
        '[[hermes-channels:intent {\n"schemaVersion": 1,\n"intent": "inform",\n"summary": "x"\n}]]'
    )
    visible, envelope = parse_agent_output(text)
    assert visible == "Done."
    assert envelope.intent == "inform"
