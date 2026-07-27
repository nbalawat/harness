import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
import tools  # noqa: E402

AGENT = {"name": "drafter", "tools": ["lookup"], "denied_tools": ["send_email"]}


def test_allowed_tool_invokes():
    tools.register("lookup", lambda q: f"found:{q}")
    assert tools.invoke(AGENT, "lookup", q="x") == "found:x"


def test_denied_and_unlisted_raise():
    tools.register("send_email", lambda: "sent")
    with pytest.raises(tools.ToolDenied):
        tools.invoke(AGENT, "send_email")
    with pytest.raises(tools.ToolDenied):
        tools.invoke(AGENT, "never_granted")
