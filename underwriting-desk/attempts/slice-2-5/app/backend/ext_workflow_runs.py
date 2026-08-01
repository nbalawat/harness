"""workflow-engine endpoints: start, tick, inspect."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine
from db import store

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


def _governed_deal(run_id: str) -> dict | None:
    """The deal, if any, whose approved process this run IS."""
    for deal in store.list("deals"):
        if deal.get("workflow_run_id") == run_id:
            return deal
    return None


@router.post("/runs/{run_id}/tick")
def tick(run_id: str):
    # A deal's run is driven by the deal's own guarded endpoints, which resolve a
    # named actor, apply the role and segregation-of-duties checks, append the
    # audit row, and refuse to tick into a node no slice has delivered yet (which
    # would fail the run permanently). Ticking it here would route around all of
    # that, so the raw engine door refuses and names the owner — the same rule
    # slice 1 applied to the raw approval-flow API.
    deal = _governed_deal(run_id)
    if deal is not None:
        raise HTTPException(
            status_code=403,
            detail=(
                f"run {run_id} is the approved underwriting process for deal "
                f"{deal.get('deal_reference')}; advance it through the deal endpoints "
                "(POST /deals/{deal_reference}/drafts/{draft_type}/review) so identity, "
                "role, the human gate and the audit row all apply"
            ),
        )
    return workflow_engine.tick(run_id)


#: Borrower document bodies are carried through the run so the deterministic
#: handlers can store and parse them, but the run record is an inspectable
#: process artefact — it must not double as a full-text dump of a borrower's
#: financial statements. Reads report the shape of the text, not the text.
#: `reply` and `raw_output` are an agent node's verbatim output. The spreading
#: node is prompted WITH the borrower's statement lines, so its reply quotes
#: them — the run record must not become a second door to that text either.
_REDACTED_TEXT_FIELDS = ("text", "extracted_text", "reply", "raw_output")


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
                out[key] = f"[redacted: {len(item)} characters — read it through the deal-scoped endpoints]"
            else:
                out[key] = _redact(item)
        return out
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


@router.get("/runs/{run_id}")
def get_state(run_id: str):
    return _redact(workflow_engine.state(run_id))
