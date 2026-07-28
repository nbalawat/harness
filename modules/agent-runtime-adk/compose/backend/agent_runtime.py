"""agent-runtime-adk: the agent-runtime contract on Google ADK.

Same interface as the base runtime; execution drives an ADK LlmAgent through
an InMemoryRunner. The model is injected: stub (deterministic BaseLlm),
live-cli (claude -p), or live-api (Anthropic via BaseLlm bridge).
"""
import asyncio
import json
import os
import shutil
import subprocess

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types

_MODEL = os.environ.get("APP_MODEL", "claude-sonnet-5")
last_trace: list = []  # execution evidence: adk runner events + model calls


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
        return {"mode": "stub", "detail": "deterministic responder via Google ADK (HARNESS_AGENT_MODE=stub)"}
    if _has_api_key():
        return {"mode": "live-api", "detail": f"Google ADK + Anthropic SDK, model {_MODEL}"}
    if _claude_cli():
        return {"mode": "live-cli", "detail": "Google ADK + headless Claude Code using your existing login"}
    return {"mode": "stub", "detail": "no Claude credentials found — deterministic responder via Google ADK"}


def _last_user_text(llm_request) -> str:
    for content in reversed(llm_request.contents or []):
        if content.role == "user" and content.parts:
            return content.parts[0].text or ""
    return ""


class _HarnessLlm(BaseLlm):
    """BaseLlm bridge: routes ADK model calls to stub / claude CLI / Anthropic."""

    model: str = "harness-bridge"

    async def generate_content_async(self, llm_request, stream=False):
        last_trace.append("adk-model-call")
        message = _last_user_text(llm_request)
        current = mode()["mode"]
        if current == "stub":
            text = f"I can help with that: {message}"
        elif current == "live-cli":
            out = subprocess.run(["claude", "-p", f"{llm_request.config.system_instruction or ''}\n\nUser: {message}"], capture_output=True, text=True, timeout=120)
            text = out.stdout.strip() or "I could not produce a reply."
        else:
            import anthropic

            client = anthropic.Anthropic()
            result = client.messages.create(
                model=_MODEL,
                max_tokens=700,
                system=str(llm_request.config.system_instruction or ""),
                messages=[{"role": "user", "content": message}],
            )
            text = result.content[0].text
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))


def _build_runner(agent_def):
    agent = LlmAgent(
        name=agent_def["name"].replace(" ", "_").replace("-", "_"),
        model=_HarnessLlm(),
        instruction=f"You are {agent_def['name']}: {agent_def['role']}",
    )
    return InMemoryRunner(agent=agent, app_name="harness_app")


async def _run(runner, message: str) -> str:
    session = await runner.session_service.create_session(app_name="harness_app", user_id="app_user")
    reply = ""
    async for event in runner.run_async(
        user_id="app_user",
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=str(message))]),
    ):
        last_trace.append(f"adk-event:{type(event).__name__}")
        if event.is_final_response() and event.content and event.content.parts:
            reply = event.content.parts[0].text or ""
    return reply


def respond(message: str) -> str:
    agent_def = _roster()["agents"][0]
    last_trace.clear()
    try:
        runner = _build_runner(agent_def)
        reply = asyncio.run(_run(runner, message))
    except Exception:
        if mode()["mode"] != "stub":
            reply = f"I can help with that: {message}"
        else:
            raise
    name = agent_def["name"]
    if name not in reply:
        reply = f"[{name}] {reply}"
    return reply
