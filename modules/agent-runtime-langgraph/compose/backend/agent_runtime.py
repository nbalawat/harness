"""agent-runtime-langgraph: the agent-runtime contract on LangGraph.

Same interface as the base runtime (respond/mode/_roster); execution runs a
compiled StateGraph. The model is a node input: stub (deterministic), live-cli
(claude -p via your login), or live-api (Anthropic SDK).
"""
import json
import os
import shutil
import subprocess
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

_MODEL = os.environ.get("APP_MODEL", "claude-sonnet-5")
last_trace: list = []  # execution evidence: which graph nodes ran, in order


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
        return {"mode": "stub", "detail": "deterministic responder via LangGraph (HARNESS_AGENT_MODE=stub)"}
    if _has_api_key():
        return {"mode": "live-api", "detail": f"LangGraph + Anthropic SDK, model {_MODEL}"}
    if _claude_cli():
        return {"mode": "live-cli", "detail": "LangGraph + headless Claude Code using your existing login"}
    return {"mode": "stub", "detail": "no Claude credentials found — deterministic responder via LangGraph"}


class ChatState(TypedDict, total=False):
    message: str
    agent: dict
    grounding: str
    reply: str


def _knowledge():
    idx = os.path.join(os.path.dirname(__file__), "..", "agents", "corpus_index.json")
    if os.path.exists(idx):
        with open(idx, encoding="utf-8") as f:
            claims = json.load(f).get("claims", [])
        return "\n".join(c.get("text", "") for c in claims[:20])
    return ""


def _ground(state: ChatState) -> dict:
    last_trace.append("ground")
    return {"grounding": _knowledge()}


def _model_stub(state: ChatState) -> str:
    return f"I can help with that: {state['message']}"


def _model_live_cli(state: ChatState) -> str:
    prompt = (
        f"You are {state['agent']['name']}: {state['agent']['role']}\n"
        f"Grounding (answer ONLY from this; say so if it doesn't cover the question):\n{state['grounding']}\n\n"
        f"User: {state['message']}"
    )
    out = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=120)
    return out.stdout.strip() or "I could not produce a reply."


def _model_live_api(state: ChatState) -> str:
    import anthropic

    client = anthropic.Anthropic()
    result = client.messages.create(
        model=_MODEL,
        max_tokens=700,
        system=f"You are {state['agent']['name']}: {state['agent']['role']}. Ground answers in: {state['grounding'][:4000]}",
        messages=[{"role": "user", "content": state["message"]}],
    )
    return result.content[0].text


def _reason_with(model_fn):
    def _reason(state: ChatState) -> dict:
        last_trace.append("reason")
        return {"reply": model_fn(state)}

    return _reason


def _disclose(state: ChatState) -> dict:
    last_trace.append("disclose")
    reply = state["reply"]
    name = state["agent"]["name"]
    if name not in reply:
        reply = f"[{name}] {reply}"
    return {"reply": reply}


def _build_graph(model_fn):
    graph = StateGraph(ChatState)
    graph.add_node("ground", _ground)
    graph.add_node("reason", _reason_with(model_fn))
    graph.add_node("disclose", _disclose)
    graph.add_edge(START, "ground")
    graph.add_edge("ground", "reason")
    graph.add_edge("reason", "disclose")
    graph.add_edge("disclose", END)
    return graph.compile()


def respond(message: str) -> str:
    agent = _roster()["agents"][0]
    current = mode()["mode"]
    model_fn = {"stub": _model_stub, "live-cli": _model_live_cli, "live-api": _model_live_api}[current]
    last_trace.clear()
    graph = _build_graph(model_fn)
    try:
        result = graph.invoke({"message": str(message), "agent": agent})
        return result["reply"]
    except Exception:
        if current != "stub":
            return _disclose({"reply": _model_stub({"message": str(message)}), "agent": agent})["reply"]
        raise
