"""Test harness generated FIRST (before any agent builds) — agents build until green."""
import os
import sys

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
    assert any(row["user"] == "u1" for row in rows)


def test_unknown_table_404():
    assert client.get("/api/definitely-not-a-table").status_code == 404
