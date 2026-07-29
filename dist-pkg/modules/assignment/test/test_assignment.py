import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import assignment  # noqa: E402
import pytest  # noqa: E402


def test_round_robin_cycles_deterministically():
    picks = [assignment.round_robin(["bo", "al", "cy"], queue="t1") for _ in range(4)]
    assert picks == ["al", "bo", "cy", "al"]


def test_least_loaded_uses_load_fn_and_empty_raises():
    load = {"al": 5, "bo": 1}.get
    assert assignment.least_loaded(["al", "bo"], load) == "bo"
    with pytest.raises(ValueError):
        assignment.round_robin([])
