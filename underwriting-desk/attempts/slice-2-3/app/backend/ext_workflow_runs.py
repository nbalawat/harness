"""workflow-engine endpoints: start, tick, inspect."""
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

import ext_audit
import underwriting as uw
import workflow_engine
from ext_auth import current_user

router = APIRouter(prefix="/workflows")


class StartRequest(BaseModel):
    inputs: dict = {}
    acting_user: str | None = None


def _named_actor(authenticated, named):
    """Starting or ticking a run MUTATES the deal of record — the start route
    reaches `create_deal_at_intake` with caller-supplied inputs, exactly what
    POST /deals resolves an actor before doing. These are writes, so the
    "un-identified reads still answer" contract does not cover them, and an
    engine re-entry that records no caller is an unaudited mutation.
    """
    try:
        return uw.resolve_actor(authenticated, named, uw.DRAFT_QUEUE_ROLES)
    except uw.DomainError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


@router.get("")
def list_definitions():
    return {"workflows": [{"name": w["name"], "description": w.get("description", ""), "nodes": len(w["nodes"])} for w in workflow_engine.definitions()]}


@router.post("/{name}/start")
def start(name: str, req: StartRequest, authorization: str | None = Header(default=None)):
    actor = _named_actor(current_user(authorization), req.acting_user)
    try:
        run_id = workflow_engine.start(name, req.inputs)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=404, detail=str(e))
    ext_audit.record(
        "workflow.started",
        {"workflow": name, "run_id": run_id, "actor_user_id": actor["username"], "role": actor["role"]},
    )
    return workflow_engine.tick(run_id) | {"run_id": run_id}


@router.post("/runs/{run_id}/tick")
def tick(
    run_id: str,
    acting_user: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    actor = _named_actor(current_user(authorization), acting_user)
    ext_audit.record(
        "workflow.ticked",
        {"run_id": run_id, "actor_user_id": actor["username"], "role": actor["role"]},
    )
    return workflow_engine.tick(run_id)


#: Borrower document bodies are carried through the run so the deterministic
#: handlers can store and parse them, but the run record is an inspectable
#: process artefact — it must not double as a full-text dump of a borrower's
#: financial statements. Reads report the shape of the text, not the text.
_REDACTED_TEXT_FIELDS = ("text", "extracted_text")

#: An agent node's raw reply is folded into the run context verbatim. Since
#: slice 2 that reply carries the borrower's spread — every figure of their
#: income statement and balance sheet — so the unauthenticated run read
#: reports its shape too, never its content. The figures of record are read
#: through the deal's own role-checked routes.
_REDACTED_REPLY_FIELDS = ("reply", "raw_output")


def _redact(value):
    from ext_guard import SENSITIVE_FIELDS

    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            # A run can also be started through the generic /workflows/{name}/start
            # door, which never passed through the intake masking — so credential
            # and TIN fields are dropped on the way out regardless of how they got in.
            if key in SENSITIVE_FIELDS:
                continue
            if key in _REDACTED_TEXT_FIELDS and isinstance(item, str):
                out[key] = f"[redacted: {len(item)} characters of borrower document text]"
            elif key in _REDACTED_REPLY_FIELDS and isinstance(item, str):
                out[key] = f"[redacted: {len(item)} characters of agent output — read it through the deal's draft routes]"
            else:
                out[key] = _redact(item)
        return out
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


@router.get("/runs/{run_id}")
def get_state(run_id: str):
    return _redact(workflow_engine.state(run_id))
