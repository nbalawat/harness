import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_router  # noqa: E402

RULES = [
    {"agent": "history_agent", "keywords": ["previous", "past conversation"]},
    {"agent": "escalation_agent", "pattern": r"urgent|asap"},
]


def test_first_match_wins_and_default_falls_through():
    assert agent_router.route("show past conversation please", RULES, "drafter") == "history_agent"
    assert agent_router.route("This is URGENT", RULES, "drafter") == "escalation_agent"
    assert agent_router.route("hello", RULES, "drafter") == "drafter"
