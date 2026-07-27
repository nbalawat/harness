import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hashlib  # noqa: E402
import hmac  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def signed(body: bytes, secret="hooksecret"):
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_verified_accept_then_replay_409(monkeypatch):
    monkeypatch.setenv("APP_HOOK_SECRET_CRM", "hooksecret")
    body = b'{"deal": 42}'
    headers = {"X-Hook-Signature": signed(body), "X-Hook-Nonce": "n-1"}
    assert client.post("/hooks/crm", content=body, headers=headers).status_code == 200
    assert client.post("/hooks/crm", content=body, headers=headers).status_code == 409, "replay blocked"


def test_bad_signature_and_unknown_hook(monkeypatch):
    monkeypatch.setenv("APP_HOOK_SECRET_CRM", "hooksecret")
    assert client.post("/hooks/crm", content=b"x", headers={"X-Hook-Signature": "wrong", "X-Hook-Nonce": "n"}).status_code == 401
    assert client.post("/hooks/never", content=b"x").status_code == 404
