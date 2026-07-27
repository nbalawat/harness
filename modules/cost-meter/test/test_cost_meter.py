import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import costmeter  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_pricing_math_and_daily_totals():
    costmeter.record("claude-sonnet-5", in_tokens=1_000_000, out_tokens=0)
    costmeter.record("claude-sonnet-5", in_tokens=0, out_tokens=1_000_000)
    rows = client.get("/admin/costs").json()
    sonnet = next(r for r in rows if r["model"] == "claude-sonnet-5")
    assert sonnet["usd"] == 18.0, "1M in ($3) + 1M out ($15)"


def test_unknown_model_records_zero_not_crash():
    entry = costmeter.record("mystery-model", 1000, 1000)
    assert entry["usd"] == 0.0
