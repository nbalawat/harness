import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import row_history  # noqa: E402


def test_diffs_fields_and_hides_secrets():
    changes = row_history.track(
        "approvals", 1,
        {"status": "draft", "token": "a", "note": "x"},
        {"status": "approved", "token": "b", "note": "x"},
        actor="analyst-1",
    )
    assert changes == [{"field": "status", "from": "draft", "to": "approved"}], "secrets and unchanged fields excluded"
    entries = row_history.history("approvals", 1)
    assert entries and entries[0]["actor"] == "analyst-1"


def test_no_change_records_nothing():
    assert row_history.track("approvals", 2, {"a": 1}, {"a": 1}) == []
    assert row_history.history("approvals", 2) == []
