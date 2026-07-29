import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import session_audit  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_events_land_in_audit_with_prefix_and_no_secrets():
    session_audit.login("ana")
    session_audit.denied(None, "/admin/roles")
    events = [e["event"] for e in client.get("/audit").json()]
    assert "session.login" in events and "session.denied" in events
    dump = str(client.get("/audit").json())
    assert "Bearer" not in dump and "token" not in dump
