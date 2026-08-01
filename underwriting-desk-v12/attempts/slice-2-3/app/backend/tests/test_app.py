"""Test harness generated FIRST (before any agent builds) — agents build until green."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_chat_roundtrip():
    response = client.post("/chat", json={"message": "hello"})
    assert response.status_code == 200
    assert response.json()["reply"]


def test_generic_table_api_is_read_only():
    # The generic passthrough must never write: every mutation in this app
    # goes through an explicit, role-checked endpoint.
    created = client.post("/api/adverse_action_reasons", json={"reason_code": "TEST"})
    assert created.status_code == 405
    assert client.put("/api/adverse_action_reasons", json={}).status_code == 405
    assert client.delete("/api/adverse_action_reasons").status_code == 405


def test_generic_table_read_is_allowlisted():
    # Non-sensitive reference data the UI reads directly stays readable...
    rows = client.get("/api/adverse_action_reasons")
    assert rows.status_code == 200
    assert isinstance(rows.json(), list)
    # ...while borrower data, decisions, PII and the audit trail are not
    # reachable through the generic passthrough.
    # (/api/deals has its own scoped feature endpoint and is tested there.)
    for table in ("users", "audit_log", "approvals", "documents", "portfolio_qa_sessions"):
        assert client.get(f"/api/{table}").status_code == 403, table


def test_unknown_table_404():
    assert client.get("/api/definitely-not-a-table").status_code == 404


def test_agent_mode_endpoint():
    body = client.get("/agent/mode").json()
    assert body["mode"] == "stub"
    assert "detail" in body


def test_agents_roster_visible():
    """Transparency contract: the app must disclose its configured agents."""
    body = client.get("/agents").json()
    assert isinstance(body["agents"], list) and body["agents"]
    first = body["agents"][0]
    assert first["name"] and first["role"]
