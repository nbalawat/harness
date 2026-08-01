"""workflow-console module: the operator surface for a business process.

Renders whatever process workflow-design produced — the step graph, the work
items flowing through it, each agent/human/deterministic step's live state and
output — and lets a human start items and act at decision steps. Generic: it
reads the engine, it does not know the domain.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow
import workflow_engine

router = APIRouter(prefix="/api/process")

# Human-readable labels for step kinds (the domain UI shows these).
_KIND_LABEL = {"agent": "AI agent", "human": "Human decision", "deterministic": "System", "condition": "Routing"}


def _process(name=None):
    defs = workflow_engine.definitions()
    wf = (next((w for w in defs if w["name"] == name), None) if name else (defs[0] if defs else None))
    if wf is None:
        raise HTTPException(status_code=404, detail="no process defined")
    return wf


def _graph(wf):
    idx = {n["id"]: i for i, n in enumerate(wf["nodes"])}
    steps = []
    for i, n in enumerate(wf["nodes"]):
        deps = list(n["deps"]) if "deps" in n else ([] if i == 0 or any("deps" in m for m in wf["nodes"]) else [wf["nodes"][i - 1]["id"]])
        steps.append({
            "id": n["id"], "kind": n["kind"], "kind_label": _KIND_LABEL.get(n["kind"], n["kind"]),
            "label": n.get("label") or n["id"].replace("_", " ").title(),
            "deps": deps,
        })
    return {"name": wf["name"], "description": wf.get("description", ""), "steps": steps}


def _run_view(run_id, wf):
    st = workflow_engine.state(run_id)
    steps = []
    pending_human = None
    for n in wf["nodes"]:
        nid = n["id"]
        if nid in st["completed"]:
            state = "done"
        elif nid in st["skipped"]:
            state = "skipped"
        elif nid in st["parked"]:
            state = "waiting"
        elif st["status"] in ("completed", "failed"):
            state = "skipped"
        else:
            # ready but not yet run, or blocked on deps -> show as pending
            state = "pending"
        out = st["completed"].get(nid)
        reply = None
        if isinstance(out, dict):
            reply = out.get("reply") or out.get("summary")
            if reply is None and n["kind"] != "human":
                reply = ", ".join(f"{k}: {v}" for k, v in out.items() if k not in ("ok",))[:400]
        step = {"id": nid, "kind": n["kind"], "kind_label": _KIND_LABEL.get(n["kind"], n["kind"]),
                "label": n.get("label") or nid.replace("_", " ").title(), "state": state, "output": reply}
        if state == "waiting":
            item = approval_flow._find(st["parked"][nid])
            q = (item or {}).get("payload", {}).get("question", "Approve this step?")
            pending_human = {"step": nid, "approval_id": st["parked"][nid], "question": q}
            step["question"] = q
        steps.append(step)
    inputs = st["context"].get("inputs", {})
    title = inputs.get("title") or inputs.get("name") or inputs.get("subject") or run_id
    done = sum(1 for s in steps if s["state"] in ("done", "skipped"))
    return {
        "run_id": run_id, "status": st["status"], "title": title, "inputs": inputs,
        "steps": steps, "progress": {"done": done, "total": len(steps)},
        "pending_human": pending_human, "error": st.get("error"),
    }


def _all_run_ids():
    ids = []
    for e in list(getattr(__import__("db").store, "list")("_wf_events")):
        if e["type"] == "run.started" and e["run_id"] not in ids:
            ids.append(e["run_id"])
    return ids


class StartRequest(BaseModel):
    inputs: dict = {}
    process: str | None = None


class Decision(BaseModel):
    approve: bool
    by: str = "operator@local"
    reason: str = ""


@router.get("")
def process_def():
    return _graph(_process())


@router.get("/runs")
def list_runs():
    wf = _process()
    runs = [_run_view(rid, wf) for rid in _all_run_ids()]
    runs.reverse()
    counts = {
        "total": len(runs),
        "running": sum(1 for r in runs if r["status"] in ("running", "parked")),
        "waiting": sum(1 for r in runs if r["status"] == "parked"),
        "done": sum(1 for r in runs if r["status"] == "completed"),
    }
    return {"runs": runs, "counts": counts}


@router.post("/runs", status_code=201)
def start_run(req: StartRequest):
    wf = _process(req.process)
    run_id = workflow_engine.start(wf["name"], req.inputs)
    return _run_view(run_id, wf)


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    workflow_engine.tick(run_id)  # advance any steps that became ready
    return _run_view(run_id, _process())


@router.post("/runs/{run_id}/decide")
def decide(run_id: str, req: Decision):
    wf = _process()
    st = workflow_engine.state(run_id)
    if not st["parked"]:
        raise HTTPException(status_code=409, detail="no step is waiting on a decision")
    for approval_id in st["parked"].values():
        if req.approve:
            approval_flow.approve(approval_id, req.by, req.reason)
        else:
            approval_flow.reject(approval_id, req.by, req.reason or "declined")
    workflow_engine.tick(run_id)
    return _run_view(run_id, wf)
