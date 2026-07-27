import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sched as scheduling  # noqa: E402


def test_due_logic_and_failure_isolation():
    runs = []
    scheduling.register("good", 60, lambda: runs.append("good"))
    scheduling.register("bad", 60, lambda: 1 / 0)
    first = scheduling.run_due(now=1000)
    assert set(first) == {"good", "bad"}
    assert scheduling.run_due(now=1030) == [], "not due yet"
    assert scheduling.run_due(now=1061) and runs.count("good") == 2
    assert scheduling.jobs()["bad"]["failures"] == 2, "failures counted, others unaffected"
