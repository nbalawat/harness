"""agent-runtime module v0.2: hosts the app's agents.

Modes (auto-detected, visible via mode()):
- "live-api": Anthropic SDK with an API key (ANTHROPIC_API_KEY / ant profile)
- "live-cli": headless Claude Code (`claude -p`) using the user's existing login
- "stub":    deterministic offline responder — used by tests/evals (HARNESS_AGENT_MODE=stub)
             and whenever no credentials are available

respond() is the single entry point; the roster (agents/roster.json) is the
contract for persona and policy in every mode.
"""
import json
import os
import shutil
import subprocess

_BASE = os.path.dirname(os.path.abspath(__file__))
_MODEL = os.environ.get("APP_AGENT_MODEL", "claude-opus-5")


def _roster():
    with open(os.path.join(_BASE, "..", "agents", "roster.json")) as f:
        return json.load(f)


def _knowledge() -> str:
    """Grounding corpus for the agent, if the build produced one."""
    for name in ("corpus_index.json",):
        p = os.path.join(_BASE, "..", "agents", name)
        if os.path.exists(p):
            try:
                with open(p) as f:
                    data = json.load(f)
                docs = data if isinstance(data, list) else data.get("documents") or data.get("sources") or []
                parts = []
                for d in docs:
                    if isinstance(d, dict):
                        parts.append(f"## {d.get('title', d.get('id', 'doc'))}\n{d.get('text', d.get('summary', ''))}")
                return "\n\n".join(parts)[:20000]
            except Exception:
                return ""
    return ""


def _claude_cli():
    return os.environ.get("CLAUDE_CODE_EXECPATH") or shutil.which("claude")


def _has_api_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")) or os.path.exists(
        os.path.expanduser("~/.config/anthropic")
    )


def mode() -> dict:
    if os.environ.get("HARNESS_AGENT_MODE") == "stub":
        return {"mode": "stub", "detail": "deterministic responder (HARNESS_AGENT_MODE=stub)"}
    if _has_api_key():
        return {"mode": "live-api", "detail": f"Anthropic SDK, model {_MODEL}"}
    if _claude_cli():
        return {"mode": "live-cli", "detail": "headless Claude Code using your existing login"}
    return {"mode": "stub", "detail": "no Claude credentials found — deterministic responder"}


def _system_prompt(agent: dict) -> str:
    return (
        f"You are {agent['name']}. {agent['role']}\n"
        "Rules: identify yourself as an automated draft pending analyst approval. "
        "Ground answers ONLY in the provided knowledge; if the knowledge does not cover the question, "
        "say it is not covered and hand off to a human analyst. Be concise. Answer directly without using tools."
    )


def _respond_stub(agent: dict, message: str) -> str:
    return f"[{agent['name']}] I can help with that: {message}"


def _respond_api(agent: dict, message: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    result = client.messages.create(
        model=_MODEL,
        max_tokens=1024,
        system=_system_prompt(agent),
        messages=[{"role": "user", "content": f"<knowledge>\n{_knowledge()}\n</knowledge>\n\nQuestion: {message}"}],
    )
    return "".join(block.text for block in result.content if block.type == "text")


def _respond_cli(agent: dict, message: str) -> str:
    prompt = (
        _system_prompt(agent)
        + f"\n\n<knowledge>\n{_knowledge()}\n</knowledge>\n\nQuestion: {message}\n\nReply with the draft answer only."
    )
    result = subprocess.run(
        [_claude_cli(), "-p", prompt, "--output-format", "text"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300])
    return result.stdout.strip()


def _select_agent(agent_name: str | None = None) -> dict:
    agents = _roster()["agents"]
    if agent_name:
        for a in agents:
            if a["name"] == agent_name:
                return a
    return agents[0]


def respond(message: str, agent_name: str | None = None) -> str:
    """Single LLM entry point. Defaults to the roster's first agent (the
    chat-shell's Portfolio Q&A Agent) for backward compatibility; pass
    agent_name to address one of the app's other roster agents by name."""
    agent = _select_agent(agent_name)
    current = mode()["mode"]
    try:
        if current == "live-api":
            return _respond_api(agent, message)
        if current == "live-cli":
            return _respond_cli(agent, message)
    except Exception:
        pass  # live path failed — degrade gracefully to the deterministic responder
    return _respond_stub(agent, message)
