import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flags  # noqa: E402


def test_on_off_and_deterministic_percent():
    flags.enable("new-editor")
    assert flags.is_enabled("new-editor", "anyone")
    flags.disable("new-editor")
    assert not flags.is_enabled("new-editor", "anyone")

    flags.rollout("beta-search", 50)
    verdicts = [flags.is_enabled("beta-search", f"user-{i}") for i in range(100)]
    assert 25 < sum(verdicts) < 75, "roughly half"
    assert all(flags.is_enabled("beta-search", "user-7") == verdicts[7] for _ in range(5)), "stable per user"


def test_unknown_flag_defaults_off():
    assert flags.is_enabled("never-defined", "u") is False
