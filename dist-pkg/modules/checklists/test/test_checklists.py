import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import checklists  # noqa: E402
import pytest  # noqa: E402


def test_lifecycle_and_progress():
    c = checklists.create("onboarding", ["laptop", "badge", "training"])
    checklists.toggle(c["id"], "laptop")
    checklists.toggle(c["id"], "badge")
    p = checklists.progress(c["id"])
    assert p == {"done": 2, "total": 3, "percent": 67}
    with pytest.raises(KeyError):
        checklists.toggle(c["id"], "nonexistent")
