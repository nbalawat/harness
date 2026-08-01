"""approval-flow endpoints (under /workflow — never elsewhere).

Every route here changes approval state, so every route resolves the caller
through the foundation identity layer FIRST: `identity.require_actor` is
fail-closed (401 with no identity, 403 for an identity that resolves to no
stored, active user), so a submission can no longer be approved or rejected by
an anonymous or invented actor.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow
import identity

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
    submitter = identity.require_actor(req.by, action="submit an item for approval")
    return approval_flow.submit(req.kind, req.payload, submitter["email"])


@router.get("/submissions/pending")
def pending():
    return approval_flow.pending()


@router.post("/submissions/{item_id}/approve")
def approve(item_id: int, req: DecisionRequest):
    actor = identity.require_actor(req.actor, action="approve this submission")
    try:
        return approval_flow.approve(item_id, actor["email"], req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/submissions/{item_id}/reject")
def reject(item_id: int, req: DecisionRequest):
    actor = identity.require_actor(req.actor, action="reject this submission")
    try:
        return approval_flow.reject(item_id, actor["email"], req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
