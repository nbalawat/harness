import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_gate_idempotency_and_determinism(monkeypatch):
    monkeypatch.delenv("APP_ALLOW_SEED", raising=False)
    assert client.post("/admin/seed").status_code == 403, "refused without explicit opt-in"

    monkeypatch.setenv("APP_ALLOW_SEED", "1")
    first = client.post("/admin/seed").json()
    assert first["seeded"] is True and first["counts"]["conversations"] == 2
    second = client.post("/admin/seed").json()
    assert second["seeded"] is False, "idempotent"
