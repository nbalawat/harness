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
    # .get(), not row["user"]: the conversations table also gets rows from
    # POST /chat (grounded-draft-chat slice), which have no "user" key.
    assert any(row.get("user") == "u1" for row in rows)


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


def test_conversation_history_list_and_detail():
    """REQ-004/REQ-005: conversations persist past the session and the full
    record (question, draft, citations, approval decision) stays reviewable."""
    chat = client.post(
        "/chat", json={"conversation_id": "conv-test-history", "message": "Why keep records?"}
    )
    assert chat.status_code == 200

    listing = client.get("/conversations")
    assert listing.status_code == 200
    rows = listing.json()
    conversation_ids = [row.get("conversation_id") for row in rows]
    assert "conv-test-history" in conversation_ids
    ours = next(row for row in rows if row.get("conversation_id") == "conv-test-history")
    assert "created_at" in ours

    detail = client.get("/conversations/conv-test-history")
    assert detail.status_code == 200
    body = detail.json()
    assert body["messages"][0]["analyst_question"] == "Why keep records?"
    assert "automated draft" in body["messages"][0]["assistant_draft"].lower()
    assert "citations" in body["messages"][0]
    assert body["approval"] is None  # no decision recorded yet

    approval = client.post(
        "/approvals",
        json={"conversation_id": "conv-test-history", "decision": "approve", "analyst_id": "analyst-test"},
    )
    assert approval.status_code == 200

    detail_after_approval = client.get("/conversations/conv-test-history").json()
    assert detail_after_approval["approval"]["decision"] == "approve"
    assert detail_after_approval["approval"]["analyst_id"] == "analyst-test"
    assert "approved_at" in detail_after_approval["approval"]


def test_conversation_detail_404_for_unknown():
    assert client.get("/conversations/conv-does-not-exist-at-all").status_code == 404
