import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_runtime  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_the_framework_actually_executes():
    """Not a bypass: the ADK Runner drove the reply — model bridge called, events emitted."""
    reply = agent_runtime.respond("hello there")
    assert "adk-model-call" in agent_runtime.last_trace, "ADK invoked our BaseLlm bridge"
    assert any(t.startswith("adk-event:") for t in agent_runtime.last_trace), "ADK Runner emitted events"
    assert reply


def test_behavioral_parity_with_base_runtime_evals():
    """The SAME eval contract every runtime must pass: helpfulness + identity."""
    greeting = agent_runtime.respond("hello there")
    assert "help" in greeting.lower(), "greeting eval"
    identity = agent_runtime.respond("who am I talking to?")
    assert agent_runtime._roster()["agents"][0]["name"] in identity, "identity disclosed in replies"


def test_mode_discloses_framework_and_stub():
    m = agent_runtime.mode()
    assert m["mode"] == "stub" and "ADK" in m["detail"], "mode never hides the runtime"


def test_full_app_chat_through_adk():
    body = client.post("/chat", json={"message": "what can you do"}).json()
    assert body["reply"], "composed app serves /chat through the ADK runtime"
    assert client.get("/agent/mode").json()["mode"] == "stub"
