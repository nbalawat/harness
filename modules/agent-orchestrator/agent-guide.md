# agent-orchestrator — build guide

Lets a DETERMINISTIC step delegate cognition to an AGENT ORCHESTRATION. The
process engine controls the flow deterministically; a deterministic step handler
calls `orchestrator.orchestrate(spec, context)` to run a small agent team.

## Use it (from a deterministic step handler)
```python
import orchestrator, workflow_engine
def assess(ctx):
    result = orchestrator.orchestrate({
        "name": "vendor-assessment",
        "agents": [
            {"role": "risk", "prompt": "Assess operational risk of ${intake.name}.", "tools": ["crm.lookup"]},
            {"role": "compliance", "prompt": "Screen ${intake.name} for compliance concerns."},
            {"role": "credit", "prompt": "Give a creditworthiness read on ${intake.name}.", "tools": ["erp.credit_check"]},
        ],
        "synthesis": {"prompt": "Synthesize the specialists into one recommendation."},
    }, ctx)
    return {"assessment": result["synthesis"], "findings": result["findings"]}
workflow_engine.register_handler("assess", assess)
```

## What it does
- Runs each specialist agent; a specialist that lists `tools` first pulls those
  enterprise systems (via the integration-hub MCP connectors) and reasons over
  the results.
- A synthesizer agent combines the findings.
- FRAMEWORK-NEUTRAL: calls `agent_runtime.respond` — whichever adapter is
  composed (Claude Agent SDK by default, LangGraph, or Google ADK) runs it.
- Every agent + tool call is audited.
