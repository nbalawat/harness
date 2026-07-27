import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from statemachine import IllegalTransition, Machine  # noqa: E402

TICKET = Machine({"open": {"assign": "assigned"}, "assigned": {"resolve": "resolved", "unassign": "open"}}, initial="open")


def test_declared_paths_advance_and_undeclared_raise():
    assert TICKET.advance("open", "assign") == "assigned"
    assert TICKET.advance("assigned", "resolve") == "resolved"
    with pytest.raises(IllegalTransition):
        TICKET.advance("open", "resolve")
    assert TICKET.allowed("assigned") == ["resolve", "unassign"]
