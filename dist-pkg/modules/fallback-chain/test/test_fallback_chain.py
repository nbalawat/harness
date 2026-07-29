import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
import fallback  # noqa: E402


def test_first_success_wins_and_failures_are_recorded():
    def boom():
        raise TimeoutError("model timeout")

    result, meta = fallback.try_chain([("live", boom), ("stub", lambda: "stub answer")])
    assert result == "stub answer" and meta["used"] == "stub"
    assert meta["failures"][0]["step"] == "live"


def test_total_failure_raises_loudly():
    with pytest.raises(RuntimeError):
        fallback.try_chain([("a", lambda: 1 / 0)])
