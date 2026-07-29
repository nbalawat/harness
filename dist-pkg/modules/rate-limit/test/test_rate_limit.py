import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
os.environ["APP_RATE_LIMIT"] = "3"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_over_limit_gets_429_with_retry_after():
    codes = [client.get("/health").status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]
    blocked = client.get("/health")
    assert blocked.headers.get("retry-after")
