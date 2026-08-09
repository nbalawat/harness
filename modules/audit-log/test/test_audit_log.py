import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

from ext_audit import record  # noqa: E402

client = TestClient(app)


def test_record_and_list_newest_first():
    # Audit rows are written server-side via record() with the resolved actor —
    # there is no public POST that would let a caller forge an entry.
    record("approve", {"id": 1}, actor="officer@test")
    record("send", {"id": 2}, actor="analyst@test")
    entries = client.get("/audit").json()
    assert entries[0]["event"] == "send"
    assert entries[0]["actor"] == "analyst@test"
    assert any(e["event"] == "approve" for e in entries)


def test_no_public_write_endpoint_to_forge_entries():
    # The forge vector is closed: no POST /audit accepting a body-supplied actor.
    assert client.post("/audit", json={"event": "forged", "actor": "anyone-i-like"}).status_code in (404, 405)


def test_python_hook_records():
    entry = record("slice-test", {"k": "v"})
    assert entry["event"] == "slice-test"
    assert any(e["id"] == entry["id"] for e in client.get("/audit").json())
