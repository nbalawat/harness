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


def test_table_crud():
    # Generic /api/{table} smoke test — uses a table this app's approved data
    # model (models.TABLES) actually declares, since a generic "conversations"
    # table was never part of the underwriting data model.
    created = client.post("/api/adverse_action_reasons", json={"reason_code": "TEST"})
    assert created.status_code == 200
    rows = client.get("/api/adverse_action_reasons").json()
    assert any(row["reason_code"] == "TEST" for row in rows)


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
