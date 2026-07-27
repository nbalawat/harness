import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import errors  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def boom():
    raise ValueError("bad input 42")


def test_same_error_groups_not_multiplies():
    for _ in range(3):
        try:
            boom()
        except ValueError as e:
            errors.capture(e, {"endpoint": "/chat"})
    groups = client.get("/admin/errors").json()
    mine = [g for g in groups if g["key"].startswith("ValueError@")]
    assert len(mine) == 1 and mine[0]["count"] == 3
    assert mine[0]["last_context"] == {"endpoint": "/chat"}
