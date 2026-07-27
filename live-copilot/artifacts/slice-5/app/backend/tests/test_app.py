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
    created = client.post("/api/conversations", json={"user": "u1"})
    assert created.status_code == 200
    rows = client.get("/api/conversations").json()
    # .get(), not row["user"]: the conversations table now also gets rows from
    # POST /chat (conversation-history slice), which have no "user" key.
    assert any(row.get("user") == "u1" for row in rows)


def test_unknown_table_404():
    assert client.get("/api/definitely-not-a-table").status_code == 404


def test_agent_mode_endpoint():
    body = client.get("/agent/mode").json()
    assert body["mode"] == "stub"
    assert "detail" in body


def test_precedent_search_requires_auth():
    assert client.post("/precedents/search", json={"q": "password"}).status_code == 401


def test_precedent_search_and_reuse():
    source = "conv-test-precedent-src"
    client.post(
        "/chat",
        json={"conversation_id": source, "analyst_id": "analyst-1", "message": "How do I reset my password?"},
    )
    approve = client.post(
        "/approvals",
        json={
            "conversation_id": source,
            "analyst_id": "analyst-1",
            "decision": "approve",
            "content": "Test approved precedent answer.",
            "token": "analyst1",
        },
    )
    assert approve.status_code == 200

    search = client.post("/precedents/search", json={"q": "password", "token": "analyst1"})
    assert search.status_code == 200
    body = search.json()
    assert any(p["conversation_id"] == source for p in body["precedents"])

    no_match = client.post("/precedents/search", json={"q": "quantum teleportation refunds", "token": "analyst1"})
    assert "no matching prior conversation" in no_match.json()["message"].lower()

    target = "conv-test-precedent-target"
    client.post(
        "/chat",
        json={"conversation_id": target, "analyst_id": "analyst-1", "message": "Customer needs password help"},
    )
    reuse = client.post(
        "/drafts/reuse",
        json={
            "conversation_id": target,
            "source_conversation_id": source,
            "analyst_id": "analyst-1",
            "token": "analyst1",
        },
    )
    assert reuse.status_code == 200
    assert reuse.json()["draft"]["content"] == "Test approved precedent answer."
    assert reuse.json()["draft"]["approval_state"] == "pending"

    drafts = client.get(f"/drafts?conversation_id={target}&token=analyst1").json()["drafts"]
    assert any(d.get("source_conversation_id") == source for d in drafts)
