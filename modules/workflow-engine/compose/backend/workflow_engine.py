"""workflow-engine module: the factory's DNA inside the app — a BUSINESS
PROCESS as a dependency graph of steps. Each step is an agent (AI does the
thinking), a human (a decision), deterministic code (correctness), or a
condition (routing). Steps run when their dependencies are satisfied, so
parallel branches both execute and a join waits for all of them.

Event-sourced over db.store; state is a pure fold; human steps park via
approval-flow; agent steps reason via agent_runtime. See agent-guide.
"""
import json
import os
import re
import string
import threading

import agent_runtime
import approval_flow
from db import store
from ext_audit import record as audit

_handlers = {}
_defs_cache = None
_run_locks = {}
_locks_guard = threading.Lock()

KINDS = ("deterministic", "agent", "human", "condition")


def _lock_for(run_id):
    with _locks_guard:
        return _run_locks.setdefault(run_id, threading.Lock())


def advance_async(run_id):
    """Advance a run in a background thread so live agent steps never block the
    HTTP request; a per-run lock keeps only one tick in flight for a run."""
    def _worker():
        lock = _lock_for(run_id)
        if not lock.acquire(blocking=False):
            return  # a tick is already advancing this run
        try:
            tick(run_id)
        finally:
            lock.release()

    threading.Thread(target=_worker, daemon=True).start()


def advance(run_id):
    """Advance a run. Synchronous by default so tests, certification, and the
    smoke check stay deterministic; set HARNESS_ASYNC_EXEC (the live runtime
    does) to run steps in a background thread so the console stays responsive
    while live agents think."""
    if os.environ.get("HARNESS_ASYNC_EXEC"):
        advance_async(run_id)
    else:
        tick(run_id)


class WorkflowError(Exception):
    pass


def register_handler(name, fn):
    """Deterministic steps call registered handlers: fn(context) -> dict."""
    _handlers[name] = fn


def definitions():
    global _defs_cache
    if _defs_cache is None:
        path = os.path.join(os.path.dirname(__file__), "..", "workflows", "workflows.json")
        _defs_cache = json.load(open(path))["workflows"] if os.path.exists(path) else []
    return _defs_cache


def _deps_of(wf, node, idx):
    """A step's dependencies. Explicit `deps` wins; otherwise fall back to the
    previous step (linear back-compat) so old sequential processes still run."""
    if "deps" in node:
        return list(node["deps"])
    any_deps = any("deps" in n for n in wf["nodes"])
    if any_deps or idx == 0:
        return []
    return [wf["nodes"][idx - 1]["id"]]


def validate_definitions(defs=None):
    """Static checks scaffold/verifiers run: structure before execution."""
    problems = []
    for wf in defs if defs is not None else definitions():
        ids = {n["id"] for n in wf.get("nodes", [])}
        seen = set()
        for i, node in enumerate(wf.get("nodes", [])):
            if node["id"] in seen:
                problems.append(f"{wf['name']}: duplicate node '{node['id']}'")
            seen.add(node["id"])
            if node.get("kind") not in KINDS:
                problems.append(f"{wf['name']}/{node['id']}: unknown kind '{node.get('kind')}'")
            if node.get("kind") == "deterministic" and not node.get("handler"):
                problems.append(f"{wf['name']}/{node['id']}: deterministic step needs a handler")
            if node.get("kind") == "agent" and not node.get("prompt"):
                problems.append(f"{wf['name']}/{node['id']}: agent step needs a prompt")
            if node.get("kind") == "human" and not node.get("question"):
                problems.append(f"{wf['name']}/{node['id']}: human step needs a question")
            if node.get("kind") == "condition" and ("path" not in node or "equals" not in node):
                problems.append(f"{wf['name']}/{node['id']}: condition needs path + equals")
            for d in _deps_of(wf, node, i):
                if d not in ids:
                    problems.append(f"{wf['name']}/{node['id']}: depends on unknown step '{d}'")
            w = node.get("when")
            if w and w.get("step") not in ids:
                problems.append(f"{wf['name']}/{node['id']}: when.step -> unknown step '{w.get('step')}'")
            target = node.get("on_false")
            if target and target != "end" and target not in ids:
                problems.append(f"{wf['name']}/{node['id']}: on_false -> unknown node '{target}'")
    return problems


def _events(run_id):
    return [e for e in store.list("_wf_events") if e["run_id"] == run_id]


def _append(run_id, type_, **data):
    return store.insert("_wf_events", {"run_id": run_id, "type": type_, **data})


def state(run_id):
    """Pure fold. Tracks the completed / skipped / parked sets of the graph."""
    st = {
        "status": "unknown", "workflow": None, "context": {"inputs": {}},
        "completed": {}, "skipped": [], "parked": {}, "error": None,
    }
    terminal = None
    for e in _events(run_id):
        t = e["type"]
        if t == "run.started":
            st.update(status="running", workflow=e["workflow"])
            st["context"] = {"inputs": e["inputs"]}
        elif t == "node.completed":
            st["completed"][e["node"]] = e["output"]
            st["context"][e["node"]] = e["output"]
            st["parked"].pop(e["node"], None)
        elif t == "node.skipped":
            if e["node"] not in st["skipped"]:
                st["skipped"].append(e["node"])
        elif t == "node.parked":
            st["parked"][e["node"]] = e["approval_id"]
        elif t == "run.completed":
            terminal = "completed"
        elif t == "run.failed":
            terminal = "failed"
            st["error"] = e.get("error")
    if terminal:
        st["status"] = terminal
    elif st["parked"]:
        st["status"] = "parked"
    elif st["status"] == "unknown":
        st["status"] = "unknown"
    else:
        st["status"] = "running"
    return st


def start(workflow_name, inputs=None):
    wf = next((w for w in definitions() if w["name"] == workflow_name), None)
    if wf is None:
        raise WorkflowError(f"unknown workflow '{workflow_name}'")
    run = _append("pending", "run.reserve")
    run_id = f"wf-{run['id']}"
    _append(run_id, "run.started", workflow=workflow_name, inputs=inputs or {})
    audit("workflow.started", {"run": run_id, "workflow": workflow_name})
    advance(run_id)
    return run_id


def _ctx_get(context, dotted):
    value = context
    for seg in dotted.split("."):
        if not isinstance(value, dict) or seg not in value:
            return None
        value = value[seg]
    return value


def _render(template, context):
    # Steps reference each other's outputs as ${step.field} (or ${step}).
    # string.Template only matches ${identifier}, so we flatten to underscores
    # AND normalize dotted placeholders in the template to match.
    flat = {}
    for node_id, out in context.items():
        if isinstance(out, dict):
            for k, v in out.items():
                flat[f"{node_id}_{k}"] = str(v)
        flat[node_id] = json.dumps(out) if isinstance(out, dict) else str(out)
    normalized = re.sub(
        r"\$\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\}",
        lambda m: "${" + m.group(1).replace(".", "_") + "}",
        template,
    )
    return string.Template(normalized).safe_substitute(**flat)


def _check_contract(node, output):
    for field in (node.get("output_schema") or {}).get("required", []):
        if not isinstance(output, dict) or field not in output:
            return f"output missing required field '{field}'"
    return None


def _extract_json(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


def _structured_respond(prompt, contract):
    """Agent output as a REVIEWABLE contract. The agent returns a small JSON
    object — the declared fields plus a one-line `rationale` and a `confidence`
    (low|medium|high) — so a human reviews STRUCTURED data, not an essay. This is
    framework-agnostic (runs over any agent_runtime) and always yields structure:
    if the model returns prose, it degrades to a structured object carrying the
    prose as the rationale. That keeps review consistent across every framework."""
    fields = [f if isinstance(f, str) else (f or {}).get("name") for f in (contract or [])]
    fields = [f for f in fields if f]
    ask = (prompt + "\n\nReturn ONLY a JSON object with these keys: " + ", ".join(fields)
           + ', plus "rationale" (one sentence) and "confidence" (one of low|medium|high).'
           + " No text outside the JSON.")
    reply = agent_runtime.respond(ask)
    data = _extract_json(reply)
    if not isinstance(data, dict):
        data = {"rationale": (reply or "").strip()[:220], "confidence": "medium"}
    for f in fields:
        data.setdefault(f, "n/a")
    data.setdefault("rationale", "")
    data.setdefault("confidence", "medium")
    return data


def _wf_of(name):
    return next(w for w in definitions() if w["name"] == name)


def _resolve_parks(run_id, st):
    """Complete any human step whose approval was decided; fail on rejection."""
    for node_id, approval_id in list(st["parked"].items()):
        decided = approval_flow._find(approval_id)
        if decided is None or decided["status"] == "pending":
            continue
        node = next(n for n in _wf_of(st["workflow"])["nodes"] if n["id"] == node_id)
        if decided["status"] == "approved":
            _append(run_id, "run.resumed", node=node_id)
            _append(run_id, "node.completed", node=node_id, output={"approved": True, "by": decided.get("decided_by")})
            audit("workflow.step_approved", {"run": run_id, "node": node_id, "by": decided.get("decided_by")})
        else:
            _append(run_id, "run.failed", error=f"rejected at '{node_id}' by {decided.get('decided_by')}")
            audit("workflow.rejected", {"run": run_id, "node": node_id})
            return False
    return True


def _when_ok(node, st):
    """A step gated by `when:{step,equals}`: True=run, False=skip, None=not-ready."""
    w = node.get("when")
    if not w:
        return True
    step = w["step"]
    if step not in st["completed"]:
        if step in st["skipped"]:
            return False
        return None
    val = st["completed"][step]
    got = val.get(w["field"], val) if isinstance(val, dict) and "field" in w else val
    return got == w["equals"]


def tick(run_id):
    """Advance the graph: run every step whose deps are satisfied; park at
    human steps; a step's `when` can skip it. Deterministic and re-entrant."""
    st = state(run_id)
    if st["status"] in ("completed", "failed"):
        return st
    if not _resolve_parks(run_id, st):
        return state(run_id)
    st = state(run_id)

    wf = _wf_of(st["workflow"])
    nodes = {n["id"]: n for n in wf["nodes"]}
    node_idx = {n["id"]: i for i, n in enumerate(wf["nodes"])}

    progressed = True
    while progressed:
        progressed = False
        st = state(run_id)
        if st["status"] in ("failed",):
            return st
        for node in wf["nodes"]:
            nid = node["id"]
            if nid in st["completed"] or nid in st["skipped"] or nid in st["parked"]:
                continue
            deps = _deps_of(wf, node, node_idx[nid])
            if not all(d in st["completed"] or d in st["skipped"] for d in deps):
                continue
            # Branch pruning: a node is pruned ONLY when EVERY dependency was
            # skipped (it sits wholly inside an untaken branch). A node with at
            # least one COMPLETED dependency is on the taken path — it is a merge
            # point and must run, never be silently skipped. (The old rule pruned
            # on ANY skipped dep, which could skip a human-approval gate that a
            # branch merged back into — defeating the human-in-the-loop control.)
            if deps and all(d in st["skipped"] for d in deps):
                _append(run_id, "node.skipped", node=nid, reason="upstream_skipped")
                progressed = True
                continue
            gate = _when_ok(node, st)
            if gate is None:
                continue
            if gate is False:
                _append(run_id, "node.skipped", node=nid, reason="condition")
                progressed = True
                continue

            try:
                if node["kind"] == "deterministic":
                    handler = _handlers.get(node["handler"])
                    if handler is None:
                        raise WorkflowError(f"no handler registered for '{node['handler']}'")
                    output = handler(dict(st["context"])) or {}
                    problem = _check_contract(node, output)
                    if problem:
                        raise WorkflowError(f"contract violation at '{nid}': {problem}")
                    _append(run_id, "node.completed", node=nid, output=output)
                elif node["kind"] == "agent":
                    prompt = _render(node["prompt"], st["context"])
                    contract = node.get("output_contract")
                    # A step with an output_contract returns REVIEWABLE structured
                    # data (fields + rationale + confidence); otherwise, free text.
                    output = _structured_respond(prompt, contract) if contract else {"reply": agent_runtime.respond(prompt)}
                    problem = _check_contract(node, output)
                    if problem:
                        retry = prompt + f"\n\nPrevious attempt failed: {problem}. Fix this."
                        output = _structured_respond(retry, contract) if contract else {"reply": agent_runtime.respond(retry)}
                    _append(run_id, "node.completed", node=nid, output=output)
                    audit("workflow.agent_step", {"run": run_id, "node": nid})
                elif node["kind"] == "condition":
                    value = _ctx_get(st["context"], node["path"])
                    matched = value == node["equals"]
                    _append(run_id, "node.completed", node=nid, output={"matched": matched, "value": value})
                    # Linear back-compat: `on_false` short-circuits the branch —
                    # skip declaration-order steps after this until the target
                    # (or all remaining for "end"). `when` is the DAG-native form.
                    if not matched and node.get("on_false"):
                        target = node["on_false"]
                        after = False
                        for m in wf["nodes"]:
                            if m["id"] == nid:
                                after = True
                                continue
                            if not after or m["id"] == target:
                                if m["id"] == target:
                                    break
                                continue
                            # A human approval gate is NEVER silently skipped by a
                            # branch short-circuit — in a compliance workflow that
                            # would bypass the human-in-the-loop decision. It is
                            # honored (it parks) even on the on_false path.
                            if m.get("kind") == "human":
                                continue
                            _append(run_id, "node.skipped", node=m["id"], reason="branch_not_taken")
                elif node["kind"] == "human":
                    item = approval_flow.submit(
                        f"workflow:{st['workflow']}",
                        {"run": run_id, "node": nid, "question": _render(node["question"], st["context"])},
                        submitted_by="workflow-engine",
                    )
                    _append(run_id, "node.parked", node=nid, approval_id=item["id"])
                    audit("workflow.parked", {"run": run_id, "node": nid, "approval": item["id"]})
                progressed = True
            except Exception as e:
                _append(run_id, "run.failed", error=str(e)[:300])
                audit("workflow.failed", {"run": run_id, "node": nid, "error": str(e)[:120]})
                return state(run_id)

    st = state(run_id)
    if st["status"] == "failed":
        return st
    done = {*st["completed"], *st["skipped"]}
    if st["parked"]:
        return st  # waiting on one or more human steps
    if all(n["id"] in done for n in wf["nodes"]):
        _append(run_id, "run.completed")
        audit("workflow.completed", {"run": run_id, "workflow": st["workflow"]})
    return state(run_id)
