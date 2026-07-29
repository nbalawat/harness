import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ext_healthz  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_components_and_overall_verdict():
    body = client.get("/healthz").json()
    assert body["ok"] is True
    assert body["components"]["store"]["ok"] and "mode=stub" in body["components"]["agent_engine"]["detail"]


def test_failing_registered_check_flips_verdict():
    ext_healthz.register("downstream", lambda: (False, "connection refused"))
    body = client.get("/healthz").json()
    assert body["ok"] is False and body["components"]["downstream"]["ok"] is False
    ext_healthz._checks.pop("downstream")
