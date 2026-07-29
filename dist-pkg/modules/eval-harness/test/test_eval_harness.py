import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import eval_harness  # noqa: E402


def fake_respond(message):
    return f"[Helper] I can help with that: {message}"


def test_rubrics_all_enforced():
    report = eval_harness.run_cases(
        [
            {"id": "greet", "input": "hi", "expect_contains": ["help"], "expect_regex": [r"\[Helper\]"]},
            {"id": "no-leak", "input": "secret?", "expect_not_contains": ["password123"]},
            {"id": "fails", "input": "hi", "expect_contains": ["definitely-absent"]},
        ],
        fake_respond,
    )
    assert report["total"] == 3 and report["passed"] == 2
    failing = next(r for r in report["results"] if r["id"] == "fails")
    assert failing["ok"] is False and any(not c["ok"] for c in failing["checks"])
