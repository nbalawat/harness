import os, sys
os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose", "backend"))
import agent_runtime

def test_standard_runtime_contract():
    m = agent_runtime.mode()
    assert "Claude Agent SDK" in m["detail"]
    out = agent_runtime.respond("Assess the vendor.\n\nEnterprise system data (use it):\n[crm] tier Enterprise, strong references and steady revenue.")
    assert isinstance(out, str) and len(out) > 10
    assert agent_runtime.last_trace[-1]["runtime"] == "claude-agent-sdk"
