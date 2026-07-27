import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ics  # noqa: E402


def test_event_roundtrip():
    text = ics.event("SLA review", "2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z", uid="rev-1")
    assert "BEGIN:VCALENDAR" in text and "DTSTART:20260801T090000Z" in text
    events = ics.parse(text)
    assert events[0]["summary"] == "SLA review" and events[0]["uid"] == "rev-1"
