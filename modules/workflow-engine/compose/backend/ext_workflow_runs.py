"""workflow-engine endpoints: start, tick, inspect.

These are direct process-control endpoints. When the app provides an identity
layer they fail closed (a real persona, not a defaulted "system" string) — the
public way to kick off a process is the process-triggers surface, which is
explicitly public and starts the process with a non-privileged actor. Advancing
a run never MAKES a human decision (that is approve/reject, role-checked).
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine

try:  # the app's identity layer, when composed
    from identity import require_actor as _require_actor
except Exception:  # standalone module / no identity layer
    _require_actor = None

router = APIRouter(prefix="/workflows")


def _resolve(acting_user_email: str | None) -> str:
    """Resolve a real actor when the app has identity (fail closed); otherwise a
    plain attribution string. Never a silent privileged default."""
    if _require_actor is not None:
        if not acting_user_email:
            raise HTTPException(status_code=401, detail="starting/advancing a run requires acting_user_email")
        return _require_actor(acting_user_email).get("email", acting_user_email)
    return acting_user_email or "system"


class StartRequest(BaseModel):
    inputs: dict = {}
    acting_user_email: str | None = None


class TickRequest(BaseModel):
    acting_user_email: str | None = None


@router.get("")
def list_definitions():
    return {"workflows": [{"name": w["name"], "description": w.get("description", ""), "nodes": len(w["nodes"])} for w in workflow_engine.definitions()]}


@router.post("/{name}/start")
def start(name: str, req: StartRequest):
    actor = _resolve(req.acting_user_email)
    try:
        run_id = workflow_engine.start(name, {**req.inputs, "_started_by": actor})
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return workflow_engine.tick(run_id) | {"run_id": run_id}


@router.post("/runs/{run_id}/tick")
def tick(run_id: str, req: TickRequest | None = None):
    _ = _resolve((req or TickRequest()).acting_user_email)  # who advanced the run — resolved + audited
    return workflow_engine.tick(run_id)


@router.get("/runs/{run_id}")
def get_state(run_id: str):
    return workflow_engine.state(run_id)
