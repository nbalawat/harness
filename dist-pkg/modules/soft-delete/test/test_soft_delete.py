import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import soft_delete  # noqa: E402
from db import store  # noqa: E402


def test_delete_hides_but_preserves_and_restore_returns():
    row = store.insert("conversations", {"user": "keep-me"})
    soft_delete.delete("conversations", row["id"])
    assert row["id"] not in [r["id"] for r in soft_delete.active("conversations")]
    assert row["id"] in [r["id"] for r in soft_delete.deleted("conversations")], "auditors still see it"
    assert soft_delete.restore("conversations", row["id"]) is True
    assert row["id"] in [r["id"] for r in soft_delete.active("conversations")]
