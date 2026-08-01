"""workflow-engine endpoints: start, tick, inspect."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine

router = APIRouter(prefix="/workflows")


class StartRequest(BaseModel):
    inputs: dict = {}
    acting_user_email: str = "system"


class TickRequest(BaseModel):
    acting_user_email: str = "system"


@router.get("")
def list_definitions():
    return {"workflows": [{"name": w["name"], "description": w.get("description", ""), "nodes": len(w["nodes"])} for w in workflow_engine.definitions()]}


@router.post("/{name}/start")
def start(name: str, req: StartRequest):
    try:
        run_id = workflow_engine.start(name, {**req.inputs, "_started_by": req.acting_user_email})
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return workflow_engine.tick(run_id) | {"run_id": run_id}


@router.post("/runs/{run_id}/tick")
def tick(run_id: str, req: TickRequest | None = None):
    _ = (req or TickRequest()).acting_user_email  # who advanced the run — carried for audit
    return workflow_engine.tick(run_id)


@router.get("/runs/{run_id}")
def get_state(run_id: str):
    return workflow_engine.state(run_id)
