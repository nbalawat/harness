import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import datetime  # noqa: E402

import retention  # noqa: E402
import soft_delete  # noqa: E402
from db import store  # noqa: E402


def test_purge_respects_policy_days():
    store.insert("messages", {"content": "old", "created_at": "2020-01-01T00:00:00Z"})
    store.insert("messages", {"content": "new", "created_at": "2026-07-20T00:00:00Z"})
    now = datetime.datetime(2026, 7, 27, tzinfo=datetime.timezone.utc)
    report = retention.purge({"messages": 90}, now=now)
    assert report["messages"] == 1
    remaining = [r["content"] for r in soft_delete.active("messages")]
    assert "new" in remaining and "old" not in remaining
    assert "old" in [r["content"] for r in soft_delete.deleted("messages")], "purge is soft — auditors can still see"
