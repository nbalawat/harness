"""agent-orchestrator module: a DETERMINISTIC step invokes an AGENT ORCHESTRATION.

Two levels of orchestration, kept separate:
  - PROCESS orchestration = the deterministic workflow engine (what runs, when).
  - AGENT orchestration    = HERE: within a step, a set of agents (specialists +
    a synthesizer) that use enterprise MCP tools to accomplish the step's goal.

A deterministic step handler calls `orchestrate(spec, context)`; the engine
stays deterministic while delegating cognition to orchestrated agents. This is
FRAMEWORK-NEUTRAL — it calls through `agent_runtime` (the composed adapter:
Claude Agent SDK by default, or LangGraph / ADK), so swapping the framework
does not change the orchestration.
"""
import string

import agent_runtime
from ext_audit import record as audit

try:
    import integrations  # enterprise systems as MCP tools (optional)
except Exception:  # pragma: no cover
    integrations = None


def _render(template, ctx):
    flat = {}
    for k, v in ctx.items():
        if isinstance(v, dict):
            for kk, vv in v.items():
                flat[f"{k}_{kk}"] = str(vv)
        flat[k] = str(v)
    import re
    t = re.sub(r"\$\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\}", lambda m: "${" + m.group(1).replace(".", "_") + "}", str(template))
    return string.Template(t).safe_substitute(**flat)


def orchestrate(spec, context):
    """spec = {
        "name": str,
        "agents": [ {"role": str, "prompt": str, "tools": [connector, ...]} ],
        "synthesis": {"prompt": str}   # optional
      }
    Each specialist agent first pulls any tools it needs (enterprise MCP calls),
    then reasons; a synthesizer combines the findings. Returns a structured
    result the deterministic step records into the process context.
    """
    name = spec.get("name", "orchestration")
    subject = context.get("intake", {}).get("name") if isinstance(context.get("intake"), dict) else context.get("name")
    findings = []
    tools_used = []
    for a in spec.get("agents", []):
        tool_ctx = ""
        for t in a.get("tools", []) or []:
            if integrations is not None:
                r = integrations.call(t, {"name": subject})
                tool_ctx += f"\n[{t}] {r}"
                tools_used.append(t)
        prompt = _render(a["prompt"], context)
        if tool_ctx:
            prompt += "\n\nEnterprise system data (use it):" + tool_ctx
        reply = agent_runtime.respond(prompt).strip()
        findings.append({"role": a["role"], "finding": reply})
        audit("orchestration.agent", {"orchestration": name, "role": a["role"], "tools": a.get("tools", [])})
    synthesis = ""
    if spec.get("synthesis"):
        sp = _render(spec["synthesis"]["prompt"], context) + "\n\nSpecialist findings:\n" + \
             "\n".join(f"- {f['role']}: {f['finding']}" for f in findings)
        synthesis = agent_runtime.respond(sp).strip()
    audit("orchestration.done", {"orchestration": name, "agents": [f["role"] for f in findings], "tools": tools_used})
    return {"orchestration": name, "findings": findings, "synthesis": synthesis,
            "agents_ran": [f["role"] for f in findings], "tools_used": sorted(set(tools_used))}
