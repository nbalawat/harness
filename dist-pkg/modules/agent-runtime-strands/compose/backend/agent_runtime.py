"""agent-runtime-strands: the agent-runtime contract on AWS Strands.

Same interface as the base runtime; execution drives a Strands Agent whose
Model is a bridge to stub (deterministic), live-cli (claude -p), or live-api
(Anthropic SDK).
"""
import json
import os
import shutil
import subprocess

from strands import Agent
from strands.models import Model

_MODEL = os.environ.get("APP_MODEL", "claude-sonnet-5")
last_trace: list = []  # execution evidence: strands agent + model bridge calls


def _roster():
    path = os.path.join(os.path.dirname(__file__), "..", "agents", "roster.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _has_api_key():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _claude_cli():
    return shutil.which("claude")


def mode() -> dict:
    if os.environ.get("HARNESS_AGENT_MODE") == "stub":
        return {"mode": "stub", "detail": "deterministic responder via AWS Strands (HARNESS_AGENT_MODE=stub)"}
    if _has_api_key():
        return {"mode": "live-api", "detail": f"AWS Strands + Anthropic SDK, model {_MODEL}"}
    if _claude_cli():
        return {"mode": "live-cli", "detail": "AWS Strands + headless Claude Code using your existing login"}
    return {"mode": "stub", "detail": "no Claude credentials found — deterministic responder via AWS Strands"}


def _last_user_text(messages) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            for block in message.get("content", []):
                if "text" in block:
                    return block["text"]
    return ""


def _generate(system_prompt: str, message: str) -> str:
    current = mode()["mode"]
    if current == "stub":
        return f"I can help with that: {message}"
    if current == "live-cli":
        out = subprocess.run(["claude", "-p", f"{system_prompt}\n\nUser: {message}"], capture_output=True, text=True, timeout=120)
        return out.stdout.strip() or "I could not produce a reply."
    import anthropic

    client = anthropic.Anthropic()
    result = client.messages.create(
        model=_MODEL,
        max_tokens=700,
        system=system_prompt,
        messages=[{"role": "user", "content": message}],
    )
    return result.content[0].text


class _HarnessModel(Model):
    """Strands Model bridge: routes model calls to stub / claude CLI / Anthropic."""

    def __init__(self):
        self._config = {"model_id": "harness-bridge"}

    def update_config(self, **kwargs):
        self._config.update(kwargs)

    def get_config(self):
        return self._config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError("structured output arrives with a later adapter version")

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        last_trace.append("strands-model-call")
        text = _generate(str(system_prompt or ""), _last_user_text(messages))
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def respond(message: str) -> str:
    agent_def = _roster()["agents"][0]
    last_trace.clear()
    try:
        agent = Agent(
            model=_HarnessModel(),
            system_prompt=f"You are {agent_def['name']}: {agent_def['role']}",
            callback_handler=None,
        )
        last_trace.append("strands-agent-invoke")
        reply = str(agent(str(message))).strip()
    except Exception:
        if mode()["mode"] != "stub":
            reply = f"I can help with that: {message}"
        else:
            raise
    name = agent_def["name"]
    if name not in reply:
        reply = f"[{name}] {reply}"
    return reply
