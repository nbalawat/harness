import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import io  # noqa: E402
import json  # noqa: E402

import slog  # noqa: E402


def test_json_lines_carry_bound_context():
    slog.clear()
    slog.bind(request_id="r-1", user="ana")
    out = io.StringIO()
    line = slog.info("approval.decided", stream=out, decision="approved")
    parsed = json.loads(out.getvalue())
    assert parsed["event"] == "approval.decided" and parsed["request_id"] == "r-1" and parsed["decision"] == "approved"
    assert line["level"] == "info"


def test_clear_drops_context():
    slog.bind(user="x")
    slog.clear()
    out = io.StringIO()
    slog.warn("thing", stream=out)
    assert "user" not in json.loads(out.getvalue())
