"""workflow-console certification: drives a process through the console API,
using the real composed engine + approval-flow (no stubs)."""
import json
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
for cand in (
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose", "backend"),
    os.path.join(os.getcwd(), "backend"),
):
    if os.path.isdir(cand):
        sys.path.insert(0, cand)

import workflow_engine  # noqa: E402

_wf_dir = os.path.join(os.path.dirname(os.path.abspath(workflow_engine.__file__)), "..", "workflows")
os.makedirs(_wf_dir, exist_ok=True)
json.dump(
    {"workflows": [{"name": "proc", "description": "d", "nodes": [
        {"id": "a", "kind": "deterministic", "handler": "h", "deps": []},
        {"id": "b", "kind": "agent", "prompt": "assess ${a.ok}", "deps": ["a"]},
        {"id": "c", "kind": "human", "question": "approve?", "deps": ["b"]},
    ]}]},
    open(os.path.join(_wf_dir, "workflows.json"), "w"),
)
workflow_engine._defs_cache = None
workflow_engine.register_handler("h", lambda ctx: {"ok": True})

import ext_console  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

app = FastAPI()
app.include_router(ext_console.router)
client = TestClient(app)


def test_process_graph_and_run_lifecycle():
    g = client.get("/api/process").json()
    assert g["name"] == "proc" and len(g["steps"]) == 3
    assert [s["kind"] for s in g["steps"]] == ["deterministic", "agent", "human"]

    run = client.post("/api/process/runs", json={"inputs": {"title": "Item 1"}}).json()
    rid = run["run_id"]
    r = client.get(f"/api/process/runs/{rid}").json()
    assert r["status"] == "parked"
    assert r["pending_human"]["step"] == "c"
    steps = {s["id"]: s["state"] for s in r["steps"]}
    assert steps["a"] == "done" and steps["b"] == "done" and steps["c"] == "waiting"

    done = client.post(f"/api/process/runs/{rid}/decide", json={"approve": True}).json()
    assert done["status"] == "completed"
    assert client.get("/api/process/runs").json()["counts"]["done"] == 1
