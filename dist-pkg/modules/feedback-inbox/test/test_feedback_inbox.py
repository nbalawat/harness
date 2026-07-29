import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_submit_and_list_newest_first():
    client.post("/feedback", json={"message": "love it", "page": "chat"})
    client.post("/feedback", json={"message": "export is slow"})
    entries = client.get("/feedback").json()
    assert entries[0]["message"] == "export is slow"


def test_empty_message_rejected():
    assert client.post("/feedback", json={"message": "   "}).status_code == 400
