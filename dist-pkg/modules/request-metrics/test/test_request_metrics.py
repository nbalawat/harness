import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_requests_counted_and_exposed():
    client.get("/health")
    client.get("/health")
    body = client.get("/metrics").text
    assert 'http_requests_total{path="/health",status="200"}' in body
    assert 'http_request_latency_ms_avg{path="/health"}' in body


def test_business_counters():
    import ext_metrics

    ext_metrics.counter("drafts_created_total").inc(3)
    assert "drafts_created_total 3" in client.get("/metrics").text
