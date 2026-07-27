import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import forms  # noqa: E402

SCHEMA = {
    "title": {"type": "str", "required": True, "max_len": 10},
    "priority": {"type": "str", "choices": ["low", "high"]},
    "count": {"type": "int"},
}


def test_valid_payload_cleans():
    result = forms.validate(SCHEMA, {"title": "ok", "priority": "low", "count": 3})
    assert result["ok"] and result["cleaned"]["count"] == 3


def test_all_failure_modes_reported_together():
    result = forms.validate(SCHEMA, {"priority": "urgent", "count": "three", "junk": 1})
    joined = " ".join(result["errors"])
    assert not result["ok"]
    assert "'title' is required" in joined and "one of" in joined and "must be int" in joined and "unknown field" in joined
