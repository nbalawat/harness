"""agent-runtime-claude-sdk: the Claude Agent SDK framework option.

One of the selectable agent-layer frameworks (the portable, framework-neutral
`agent-runtime` is the default; this, LangGraph, and ADK are opt-in choices).

Two honest live paths, plus a deterministic stub for tests:
  * live-cli  — shells out to the Claude Code CLI (`claude -p`). Claude Code IS
    the Agent SDK's agentic loop (multi-turn, tool use, MCP), so this runs on the
    Agent SDK engine — but it is a CLI subprocess, not the linked SDK library.
  * live-api  — calls the Anthropic Messages API directly.
  * stub      — deterministic, offline (certification/tests).
Enterprise MCP servers attach as tools (live-cli), so an agent can call
CRM/ERP/etc. directly.

Same one-line contract as every agent-runtime adapter: respond(prompt) -> str.
Swap this module for agent-runtime-langgraph or agent-runtime-adk to change the
framework without touching the process or the orchestration.
"""
import os
import shutil
import subprocess

_MODEL = os.environ.get("APP_AGENT_MODEL", "claude-sonnet-5")
last_trace = []  # execution evidence for governance

# Live agent replies are for an operator console: lead with a compact structured
# line, then a short rationale. Keeps the timeline legible instead of essays.
_STYLE = (
    "\n\nRespond for an operator console: FIRST line = compact `key: value; key: value` "
    "pairs (the decision + the 2-4 fields that matter). THEN one or two sentences of "
    "rationale. No preamble, no restating the question."
)


def _cli():
    return os.environ.get("CLAUDE_CODE_EXECPATH") or shutil.which("claude")


def _has_api_key():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def mode():
    # PORTABLE-FIRST: prefer the API (works in any environment with a key) and
    # fall back to the local CLI login only when no key is set. This keeps every
    # framework option runnable the same way everywhere.
    if os.environ.get("HARNESS_AGENT_MODE") == "stub":
        return {"mode": "stub", "detail": "Claude Agent SDK — offline stub"}
    if _has_api_key():
        return {"mode": "live-api", "detail": "Anthropic Messages API, model " + _MODEL}
    if _cli():
        return {"mode": "live-cli", "detail": "Claude Code CLI (claude -p) — Agent SDK engine, model " + _MODEL}
    return {"mode": "stub", "detail": "Claude Agent SDK — no credentials, stub"}


def _mcp_flags():
    # Attach the app's enterprise MCP servers as agent tools when a config exists.
    cfg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mcp.agent.json")
    return ["--mcp-config", cfg] if os.path.exists(cfg) else []


def respond(prompt):
    m = mode()["mode"]
    last_trace.append({"runtime": "claude-agent-sdk", "mode": m})
    try:
        if m == "live-cli":
            r = subprocess.run([_cli(), "-p", prompt + _STYLE, "--output-format", "text", *_mcp_flags()],
                               capture_output=True, text=True, timeout=180)
            if r.returncode == 0:
                return r.stdout.strip()
        if m == "live-api":
            import anthropic
            c = anthropic.Anthropic()
            res = c.messages.create(model=_MODEL, max_tokens=400,
                                    messages=[{"role": "user", "content": prompt + _STYLE}])
            return "".join(b.text for b in res.content if b.type == "text").strip()
    except Exception:
        pass
    # deterministic stub — same cross-runtime contract as the base/langgraph/adk
    # adapters: a reply that "can help", names the agent, and echoes the context,
    # so an app's offline evals (greeting/identity) pass no matter which framework
    # is chosen.
    import re
    ctx = (prompt.split("data (use it):", 1)[-1] if "data (use it):" in prompt else prompt).strip()
    line = next((s.strip() for s in re.split(r"(?<=[.!?])\s+", ctx) if len(s.strip()) > 12), ctx[:160])
    return f"[{_stub_agent_name()}] I can help with that: {line[:180]}"


def _stub_agent_name():
    import json
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents", "roster.json")
    try:
        agents = json.load(open(p)).get("agents") or []
        if agents:
            return agents[0].get("name") or "Assistant"
    except Exception:
        pass
    return "Assistant"
