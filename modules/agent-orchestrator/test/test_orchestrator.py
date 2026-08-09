import os, sys, types
os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose", "backend"))
# stub the deps the orchestrator imports
sys.modules["agent_runtime"] = types.ModuleType("agent_runtime")
sys.modules["agent_runtime"].respond = lambda p: "assessed: " + p.split("\n")[0][:40]
sys.modules["ext_audit"] = types.ModuleType("ext_audit")
sys.modules["ext_audit"].record = lambda *a, **k: None
_integ = types.ModuleType("integrations")
_calls = []
def _call(name, params):
    _calls.append(name); return {"system": name.split(".")[0], "ok": True}
_integ.call = _call
sys.modules["integrations"] = _integ

import orchestrator

def test_deterministic_step_invokes_multi_agent_orchestration_with_tools():
    spec = {"name": "assessment", "agents": [
        {"role": "risk", "prompt": "risk of ${intake.name}", "tools": ["crm.lookup"]},
        {"role": "compliance", "prompt": "compliance of ${intake.name}"},
        {"role": "credit", "prompt": "credit of ${intake.name}", "tools": ["erp.credit_check"]},
    ], "synthesis": {"prompt": "synthesize"}}
    ctx = {"intake": {"name": "Acme Co"}}
    out = orchestrator.orchestrate(spec, ctx)
    assert out["agents_ran"] == ["risk", "compliance", "credit"]
    assert set(out["tools_used"]) == {"crm.lookup", "erp.credit_check"}  # MCP tools were used
    assert out["synthesis"], "a synthesizer combined the findings"
    assert set(_calls) == {"crm.lookup", "erp.credit_check"}
