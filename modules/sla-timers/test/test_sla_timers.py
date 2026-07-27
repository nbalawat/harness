import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import datetime  # noqa: E402

import sla  # noqa: E402

START = "2026-07-27T00:00:00Z"


def at(hour):
    return datetime.datetime(2026, 7, 27, hour, tzinfo=datetime.timezone.utc)


def test_ok_at_risk_breached_thresholds():
    assert sla.status(START, 10, now=at(5)) == "ok"
    assert sla.status(START, 10, now=at(9)) == "at_risk", "80% consumed warns BEFORE breach"
    assert sla.status(START, 10, now=at(11)) == "breached"


def test_due_at_math():
    assert sla.due_at(START, 24).startswith("2026-07-28T00:00:00")
