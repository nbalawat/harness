import json
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

WORKFLOWS = {
    "workflows": [
        {
            "name": "reply-approval",
            "description": "Draft a reply, human approves, record it.",
            "addresses": ["REQ-001"],
            "nodes": [
                {"id": "validate", "kind": "deterministic", "handler": "validate_input", "output_schema": {"required": ["ok", "topic"]}},
                {"id": "worth_it", "kind": "condition", "path": "validate.ok", "equals": True, "on_false": "end"},
                {"id": "draft", "kind": "agent", "prompt": "Draft a short reply about ${validate_topic}."},
                {"id": "approve", "kind": "human", "question": "Send this reply? ${draft_reply}"},
                {"id": "record", "kind": "deterministic", "handler": "record_reply", "output_schema": {"required": ["stored"]}},
            ],
        }
    ]
}

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_APP_ROOT = os.path.dirname(_BACKEND)
os.makedirs(os.path.join(_APP_ROOT, "workflows"), exist_ok=True)
with open(os.path.join(_APP_ROOT, "workflows", "workflows.json"), "w") as f:
    json.dump(WORKFLOWS, f)

import approval_flow  # noqa: E402
import workflow_engine  # noqa: E402
from db import store  # noqa: E402

workflow_engine.register_handler("validate_input", lambda ctx: {"ok": bool(ctx["inputs"].get("topic")), "topic": ctx["inputs"].get("topic", "")})
workflow_engine.register_handler("record_reply", lambda ctx: {"stored": True})


def test_definitions_validate():
    assert workflow_engine.validate_definitions() == []
    bad = [{"name": "x", "nodes": [{"id": "a", "kind": "nope"}, {"id": "a", "kind": "human"}]}]
    problems = workflow_engine.validate_definitions(bad)
    assert any("unknown kind" in p for p in problems) and any("duplicate" in p for p in problems)


def test_full_run_parks_at_human_and_resumes_on_approval():
    run_id = workflow_engine.start("reply-approval", {"topic": "renewals"})
    st = workflow_engine.state(run_id)
    assert st["status"] == "parked", "human node parks the run durably"
    assert "renewals" in st["context"]["validate"]["topic"]
    assert st["context"]["draft"]["reply"], "agent node produced a draft via agent_runtime (stub)"

    assert workflow_engine.tick(run_id)["status"] == "parked", "tick without a decision stays parked"

    approval_flow.approve(list(st["parked"].values())[0], "ana", "looks right")
    done = workflow_engine.tick(run_id)
    assert done["status"] == "completed"
    assert done["context"]["approve"]["approved"] is True and done["context"]["approve"]["by"] == "ana"
    assert done["context"]["record"]["stored"] is True

    events = [e["event"] for e in store.list("_audit")] if store.list("_audit") else []
    audit_events = [e["event"] for e in __import__("ext_audit")._entries]
    assert "workflow.started" in audit_events and "workflow.completed" in audit_events


def test_condition_short_circuits():
    run_id = workflow_engine.start("reply-approval", {})  # no topic -> validate.ok False
    st = workflow_engine.state(run_id)
    assert st["status"] == "completed", "condition on_false=end completes without drafting"
    assert "draft" not in st["context"]


def test_rejection_fails_the_run():
    run_id = workflow_engine.start("reply-approval", {"topic": "refunds"})
    st = workflow_engine.state(run_id)
    approval_flow.reject(list(st["parked"].values())[0], "bob", "not like this")
    done = workflow_engine.tick(run_id)
    assert done["status"] == "failed" and "rejected" in done["error"]


def test_contract_violation_fails_loud():
    workflow_engine.register_handler("validate_input", lambda ctx: {"ok": True})  # missing 'topic'
    run_id = workflow_engine.start("reply-approval", {"topic": "x"})
    st = workflow_engine.state(run_id)
    assert st["status"] == "failed" and "contract violation" in st["error"]
    workflow_engine.register_handler("validate_input", lambda ctx: {"ok": bool(ctx["inputs"].get("topic")), "topic": ctx["inputs"].get("topic", "")})


def test_dependency_graph_runs_parallel_branches_and_joins():
    defs = [{"name": "onboard", "nodes": [
        {"id": "intake", "kind": "deterministic", "handler": "vi", "deps": []},
        {"id": "a", "kind": "agent", "prompt": "x", "deps": ["intake"]},
        {"id": "b", "kind": "agent", "prompt": "y", "deps": ["intake"]},
        {"id": "join", "kind": "deterministic", "handler": "vj", "deps": ["a", "b"]},
        {"id": "gate", "kind": "human", "question": "ok?", "deps": ["join"]},
        {"id": "done", "kind": "deterministic", "handler": "vd", "deps": ["gate"]},
    ]}]
    workflow_engine._defs_cache = defs
    workflow_engine.register_handler("vi", lambda c: {"ok": True})
    workflow_engine.register_handler("vj", lambda c: {"joined": True})
    workflow_engine.register_handler("vd", lambda c: {"done": True})
    assert workflow_engine.validate_definitions(defs) == []
    rid = workflow_engine.start("onboard", {})
    st = workflow_engine.state(rid)
    # both parallel agent branches completed before the join, then parked at the gate
    assert {"intake", "a", "b", "join"}.issubset(set(st["completed"]))
    assert "gate" in st["parked"]
    approval_flow.approve(list(st["parked"].values())[0], "mgr")
    st = workflow_engine.tick(rid)
    assert st["status"] == "completed" and "done" in st["completed"]
    workflow_engine._defs_cache = None
