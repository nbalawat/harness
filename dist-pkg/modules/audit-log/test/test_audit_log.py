import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_record_and_list_newest_first():
    client.post("/audit", json={"event": "approve", "detail": {"id": 1}})
    client.post("/audit", json={"event": "send", "detail": {"id": 2}})
    entries = client.get("/audit").json()
    assert entries[0]["event"] == "send"
    assert any(e["event"] == "approve" for e in entries)


def test_python_hook_records():
    from ext_audit import record

    entry = record("slice-test", {"k": "v"})
    assert entry["event"] == "slice-test"
    assert any(e["id"] == entry["id"] for e in client.get("/audit").json())
