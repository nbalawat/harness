import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from budgeter import Budgeter, BudgetExceeded  # noqa: E402


def test_caps_enforced_pre_spend():
    b = Budgeter(cap_usd=1.00)
    b.spend("conv-1", 0.60)
    assert b.remaining("conv-1") == 0.40
    with pytest.raises(BudgetExceeded):
        b.spend("conv-1", 0.50)
    assert b.remaining("conv-1") == 0.40, "failed spend does not deduct"
    b.spend("conv-2", 0.90), "keys are independent"
