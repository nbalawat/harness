import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_runtime  # noqa: E402


def test_stub_mode_is_deterministic_and_disclosed():
    m = agent_runtime.mode()
    assert m["mode"] == "stub"
    assert "detail" in m


def test_respond_identifies_the_roster_agent():
    reply = agent_runtime.respond("hello there")
    assert isinstance(reply, str) and reply
    roster_first = agent_runtime._roster()["agents"][0]["name"]
    assert roster_first in reply, "replies must disclose which agent answered"
