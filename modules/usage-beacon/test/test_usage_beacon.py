import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_tracks_users_and_ignores_health_probes():
    # Two distinct callers + one repeat (dedup) hit a real route; health probes
    # must NOT inflate usage.
    client.get("/agents", headers={"x-firm-identity": "alice@firm.local"})
    client.get("/agents", headers={"x-firm-identity": "alice@firm.local"})
    client.get("/agents", headers={"x-firm-identity": "bob@firm.local"})
    client.get("/health")
    client.get("/healthz")
    day = list(client.get("/usage/self").json()["days"].values())[0]
    # 3 /agents + this /usage/self = 4 counted; the 2 health probes are excluded.
    assert day["requests"] == 4, day
    # alice (deduped) + bob are tracked (plus the anonymous /usage/self caller).
    assert day["uniqueUsers"] >= 2, day


def test_identity_is_never_sent_raw():
    # The self report exposes only counts, never a raw identity.
    body = client.get("/usage/self", headers={"x-firm-identity": "secret.person@firm.local"}).text
    assert "secret.person@firm.local" not in body
