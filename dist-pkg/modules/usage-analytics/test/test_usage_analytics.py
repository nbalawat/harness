import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ext_usage  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_features_counted_by_label_and_probes_excluded():
    ext_usage.label("/agents", "Agent roster")
    client.get("/agents")
    client.get("/agents")
    client.get("/health")
    usage = client.get("/admin/usage").json()
    day = list(usage)[0]
    assert usage[day]["Agent roster"] >= 2
    assert all("/health" not in features for features in usage.values()), "liveness probes are not usage"
