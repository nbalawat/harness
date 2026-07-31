"""workflow-engine module: the factory's DNA inside the app — deterministic
workflows with agentic nodes. Event-sourced over db.store; state is a pure
fold; human nodes park via approval-flow; agent nodes reason via
agent_runtime. See agent-guide.
"""
import json
import os
import string

import agent_runtime
import approval_flow
from db import store
from ext_audit import record as audit

_handlers = {}
_defs_cache = None

KINDS = ("deterministic", "agent", "human", "condition")


class WorkflowError(Exception):
    pass


def register_handler(name, fn):
    """Deterministic nodes call registered handlers: fn(context) -> dict."""
    _handlers[name] = fn


def definitions():
    global _defs_cache
    if _defs_cache is None:
        path = os.path.join(os.path.dirname(__file__), "..", "workflows", "workflows.json")
        _defs_cache = json.load(open(path))["workflows"] if os.path.exists(path) else []
    return _defs_cache


def validate_definitions(defs=None):
    """Static checks scaffold/verifiers run: structure before execution."""
    problems = []
    for wf in defs if defs is not None else definitions():
        ids = set()
        for node in wf.get("nodes", []):
            if node["id"] in ids:
                problems.append(f"{wf['name']}: duplicate node '{node['id']}'")
            ids.add(node["id"])
            if node.get("kind") not in KINDS:
                problems.append(f"{wf['name']}/{node['id']}: unknown kind '{node.get('kind')}'")
            if node.get("kind") == "deterministic" and not node.get("handler"):
                problems.append(f"{wf['name']}/{node['id']}: deterministic node needs a handler")
            if node.get("kind") == "agent" and not node.get("prompt"):
                problems.append(f"{wf['name']}/{node['id']}: agent node needs a prompt")
            if node.get("kind") == "human" and not node.get("question"):
                problems.append(f"{wf['name']}/{node['id']}: human node needs a question")
            if node.get("kind") == "condition" and ("path" not in node or "equals" not in node):
                problems.append(f"{wf['name']}/{node['id']}: condition needs path + equals")
        for node in wf.get("nodes", []):
            target = node.get("on_false")
            if target and target != "end" and target not in ids:
                problems.append(f"{wf['name']}/{node['id']}: on_false -> unknown node '{target}'")
    return problems


def _events(run_id):
    return [e for e in store.list("_wf_events") if e["run_id"] == run_id]


def _append(run_id, type_, **data):
    return store.insert("_wf_events", {"run_id": run_id, "type": type_, **data})


def state(run_id):
    """Pure fold — the same discipline as the harness scheduler."""
    st = {"status": "unknown", "workflow": None, "cursor": 0, "context": {}, "approval_id": None}
    for e in _events(run_id):
        if e["type"] == "run.started":
            st.update(status="running", workflow=e["workflow"], context={"inputs": e["inputs"]})
        elif e["type"] == "node.completed":
            st["context"][e["node"]] = e["output"]
            st["cursor"] = e["cursor"] + 1
            st.pop("blocked_on", None)
        elif e["type"] == "run.blocked":
            # Still running, just waiting on a handler a later slice registers.
            st["blocked_on"] = {"node": e.get("node"), "handler": e.get("handler")}
        elif e["type"] == "run.parked":
            st.update(status="parked", approval_id=e["approval_id"])
        elif e["type"] == "run.resumed":
            st["status"] = "running"
        elif e["type"] == "run.completed":
            st["status"] = "completed"
        elif e["type"] == "run.failed":
            st.update(status="failed", error=e.get("error"))
    return st


def start(workflow_name, inputs=None):
    wf = next((w for w in definitions() if w["name"] == workflow_name), None)
    if wf is None:
        raise WorkflowError(f"unknown workflow '{workflow_name}'")
    run = _append("pending", "run.reserve")  # reserve an id via the store
    run_id = f"wf-{run['id']}"
    _append(run_id, "run.started", workflow=workflow_name, inputs=inputs or {})
    audit("workflow.started", {"run": run_id, "workflow": workflow_name})
    tick(run_id)  # advance to the first park point; tick is idempotent
    return run_id


def _ctx_get(context, dotted):
    value = context
    for seg in dotted.split("."):
        if not isinstance(value, dict) or seg not in value:
            return None
        value = value[seg]
    return value


def _render(template, context):
    flat = {}
    for node_id, out in context.items():
        if isinstance(out, dict):
            for k, v in out.items():
                flat[f"{node_id}.{k}"] = str(v)
        flat[node_id] = json.dumps(out) if isinstance(out, dict) else str(out)
    return string.Template(template).safe_substitute(**{k.replace(".", "_"): v for k, v in flat.items()})


def _check_contract(node, output):
    for field in (node.get("output_schema") or {}).get("required", []):
        if not isinstance(output, dict) or field not in output:
            return f"output missing required field '{field}'"
    return None


def tick(run_id):
    """Advance until parked, completed, or failed. Deterministic; re-entrant."""
    st = state(run_id)
    if st["status"] == "parked":
        decided = approval_flow._find(st["approval_id"])
        if decided is None or decided["status"] == "pending":
            return state(run_id)
        _append(run_id, "run.resumed")
        node = _current_node(st)
        approved = decided["status"] == "approved"
        _complete(
            run_id,
            st,
            node,
            {"approved": approved, "action": "accepted" if approved else "rejected", "by": decided.get("decided_by")},
        )
        if decided["status"] != "approved":
            _append(run_id, "run.failed", error=f"rejected at '{node['id']}' by {decided.get('decided_by')}")
            audit("workflow.rejected", {"run": run_id, "node": node["id"]})
            return state(run_id)
        st = state(run_id)
    while st["status"] == "running":
        wf = next(w for w in definitions() if w["name"] == st["workflow"])
        if st["cursor"] >= len(wf["nodes"]):
            _append(run_id, "run.completed")
            audit("workflow.completed", {"run": run_id, "workflow": st["workflow"]})
            break
        node = wf["nodes"][st["cursor"]]
        try:
            if node["kind"] == "deterministic":
                handler = _handlers.get(node["handler"])
                if handler is None:
                    # The definition is approved end to end, but the handler
                    # for this node ships in a later slice. A run that is
                    # merely ahead of the implementation is NOT a failed run:
                    # leave it RUNNING at this cursor and stop advancing, so
                    # the next tick after that handler registers resumes
                    # exactly here instead of finding a dead run.
                    # Record it once per frontier, not once per tick — every
                    # later review re-ticks this run and would otherwise grow
                    # the event log by a row each time.
                    if (st.get("blocked_on") or {}).get("node") != node["id"]:
                        _append(run_id, "run.blocked", node=node["id"], handler=node["handler"])
                        audit("workflow.blocked", {"run": run_id, "node": node["id"], "handler": node["handler"]})
                    break
                output = handler(dict(st["context"])) or {}
                problem = _check_contract(node, output)
                if problem:
                    raise WorkflowError(f"contract violation at '{node['id']}': {problem}")
                _complete(run_id, st, node, output)
            elif node["kind"] == "agent":
                agent_name = agent_runtime.agent_for_node(st["workflow"], node["id"])
                reply = agent_runtime.respond(_render(node["prompt"], st["context"]), agent_name=agent_name)
                output = {"reply": reply}
                problem = _check_contract(node, output)
                if problem:  # one retry with feedback — the envelope pattern, scaled down
                    reply = agent_runtime.respond(
                        _render(node["prompt"], st["context"]) + f"\n\nPrevious attempt failed: {problem}. Fix this.",
                        agent_name=agent_name,
                    )
                    output = {"reply": reply}
                _complete(run_id, st, node, output)
            elif node["kind"] == "human":
                item = approval_flow.submit(f"workflow:{st['workflow']}", {"run": run_id, "node": node["id"], "question": _render(node["question"], st["context"])}, submitted_by="workflow-engine")
                _append(run_id, "run.parked", approval_id=item["id"])
                audit("workflow.parked", {"run": run_id, "node": node["id"], "approval": item["id"]})
                break
            elif node["kind"] == "condition":
                value = _ctx_get(st["context"], node["path"])
                matched = value == node["equals"]
                _complete(run_id, st, node, {"matched": matched})
                if not matched:
                    target = node.get("on_false", "end")
                    if target == "end":
                        _append(run_id, "run.completed")
                        audit("workflow.completed", {"run": run_id, "workflow": st["workflow"], "short_circuit": node["id"]})
                        break
                    while state(run_id)["cursor"] < len(wf["nodes"]) and wf["nodes"][state(run_id)["cursor"]]["id"] != target:
                        skip = wf["nodes"][state(run_id)["cursor"]]
                        _append(run_id, "node.completed", node=skip["id"], output={"skipped": True}, cursor=state(run_id)["cursor"])
        except Exception as e:
            _append(run_id, "run.failed", error=str(e)[:300])
            audit("workflow.failed", {"run": run_id, "node": node["id"], "error": str(e)[:120]})
            break
        st = state(run_id)
    return state(run_id)


def _current_node(st):
    wf = next(w for w in definitions() if w["name"] == st["workflow"])
    return wf["nodes"][st["cursor"]]


def _complete(run_id, st, node, output):
    _append(run_id, "node.completed", node=node["id"], output=output, cursor=st["cursor"])
    audit("workflow.node", {"run": run_id, "node": node["id"], "kind": node["kind"]})
