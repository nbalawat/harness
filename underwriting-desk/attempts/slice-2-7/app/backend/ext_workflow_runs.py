"""workflow-engine endpoints: start, tick, inspect."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine
from db import store

router = APIRouter(prefix="/workflows")

#: Processes that write the deal of record. Starting one here would create deals
#: and run agents with no resolved identity, no role check and no audit row; the
#: guarded endpoints own them (the same rule ext_workflow applies to gates).
GATED_WORKFLOWS = {
    "deal-underwriting": "POST /deals",
    "credit-approval": "the guarded decision endpoints (POST /deals/{ref}/... )",
}


def _deal_owning(run_id: str) -> dict | None:
    for row in store.list("deals"):
        if row.get("workflow_run_id") == run_id:
            return row
    return None


class StartRequest(BaseModel):
    inputs: dict = {}


@router.get("")
def list_definitions():
    return {"workflows": [{"name": w["name"], "description": w.get("description", ""), "nodes": len(w["nodes"])} for w in workflow_engine.definitions()]}


@router.post("/{name}/start")
def start(name: str, req: StartRequest):
    owner = GATED_WORKFLOWS.get(name)
    if owner:
        raise HTTPException(
            status_code=403,
            detail=(
                f"'{name}' writes the deal of record; start it through {owner} so a named identity, "
                "the role grant, the deterministic derivations and the audit row all apply"
            ),
        )
    try:
        run_id = workflow_engine.start(name, req.inputs)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return workflow_engine.tick(run_id) | {"run_id": run_id}


@router.post("/runs/{run_id}/tick")
def tick(run_id: str):
    """Advance a run.

    A run that belongs to a deal is refused: the owning endpoints decide when it
    is safe to advance (a slice may deliberately hold a run at its gate because
    a later node's handler is not registered yet), and `tick` is one-way — it
    marks a run FAILED on the first unregistered handler, which is terminal.
    Run ids are disclosed on the deal record, so this route would otherwise let
    an anonymous caller strand a borrower's process permanently.
    """
    deal = _deal_owning(run_id)
    if deal is not None:
        raise HTTPException(
            status_code=403,
            detail=(
                f"run '{run_id}' is the process of record for deal {deal.get('deal_reference')}; "
                "it is advanced by the endpoint that owns its current gate "
                "(POST /deals/{deal_reference}/drafts/{draft_type}/review), never by a raw tick"
            ),
        )
    return workflow_engine.tick(run_id)


#: Borrower document bodies are carried through the run so the deterministic
#: handlers can store and parse them, but the run record is an inspectable
#: process artefact — it must not double as a full-text dump of a borrower's
#: financial statements. Reads report the shape of the text, not the text.
_REDACTED_TEXT_FIELDS = ("text", "extracted_text")


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
            else:
                out[key] = _redact(item)
        return out
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


@router.get("/runs/{run_id}")
def get_state(run_id: str):
    return _redact(workflow_engine.state(run_id))
