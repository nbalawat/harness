"""approval-flow endpoints (under /workflow — never elsewhere)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow

router = APIRouter(prefix="/workflow")


class SubmitRequest(BaseModel):
    kind: str
    payload: dict
    by: str


class DecisionRequest(BaseModel):
    actor: str
    reason: str = ""


@router.post("/submissions")
def submit(req: SubmitRequest):
    return approval_flow.submit(req.kind, req.payload, req.by)


@router.get("/submissions/pending")
def pending():
    return approval_flow.pending()


@router.post("/submissions/{item_id}/approve")
def approve(item_id: int, req: DecisionRequest):
    try:
        return approval_flow.approve(item_id, req.actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/submissions/{item_id}/reject")
def reject(item_id: int, req: DecisionRequest):
    try:
        return approval_flow.reject(item_id, req.actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
