import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import classify  # noqa: E402
import pytest  # noqa: E402


def test_restricted_columns_masked_on_export_path():
    classify.set_level("conversations", "user", "restricted")
    rows = classify.restrict("conversations", [{"id": 1, "user": "jane", "topic": "billing"}])
    assert rows[0]["user"] == "[restricted]" and rows[0]["topic"] == "billing"


def test_default_level_and_invalid_level():
    assert classify.level_of("messages", "content") == "internal"
    with pytest.raises(ValueError):
        classify.set_level("x", "y", "super-secret")
