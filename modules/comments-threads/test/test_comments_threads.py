import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_threads_scoped_to_record_and_sanitized():
    client.post("/comments/approvals/1", json={"author": "ana", "text": "  looks \u0000fine  "})
    client.post("/comments/approvals/2", json={"author": "bob", "text": "other record"})
    thread = client.get("/comments/approvals/1").json()
    assert len(thread) == 1 and thread[0]["text"] == "looks fine"


def test_empty_and_oversized_rejected():
    assert client.post("/comments/approvals/1", json={"author": "x", "text": "   "}).status_code == 400
    assert client.post("/comments/approvals/1", json={"author": "x", "text": "y" * 3000}).status_code == 413
