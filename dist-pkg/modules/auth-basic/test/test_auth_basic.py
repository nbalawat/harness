import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_login_me_roundtrip():
    token = client.post("/auth/login", json={"username": "analyst-1"}).json()["token"]
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json() == {"username": "analyst-1"}


def test_bad_token_rejected():
    assert client.get("/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_empty_username_rejected():
    assert client.post("/auth/login", json={"username": "  "}).status_code == 400
