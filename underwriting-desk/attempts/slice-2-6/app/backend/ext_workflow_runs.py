"""workflow-engine endpoints: start, tick, inspect."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine

router = APIRouter(prefix="/workflows")


class StartRequest(BaseModel):
    inputs: dict = {}


@router.get("")
def list_definitions():
    return {"workflows": [{"name": w["name"], "description": w.get("description", ""), "nodes": len(w["nodes"])} for w in workflow_engine.definitions()]}


@router.post("/{name}/start")
def start(name: str, req: StartRequest):
    try:
        run_id = workflow_engine.start(name, req.inputs)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return workflow_engine.tick(run_id) | {"run_id": run_id}


@router.post("/runs/{run_id}/tick")
def tick(run_id: str):
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
