"""approval-flow endpoints (under /workflow — never elsewhere)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow

router = APIRouter(prefix="/workflow")

#: Approval items whose `kind` starts with one of these prefixes are the human
#: gates the app's own guarded endpoints own. Dispositioning one here would
#: route around the role check, the segregation-of-duties check, the written
#: rejection reason and the audit row that the owning endpoint applies — so the
#: raw approval-flow API refuses them and names the endpoint that owns the gate.
GATED_KIND_PREFIXES = ("agent_draft:", "workflow:")

GATE_OWNER = {
    "agent_draft:": "POST /deals/{deal_reference}/drafts/{draft_type}/review",
    "workflow:": "the guarded endpoint that owns the parked node (e.g. POST /deals/{deal_reference}/drafts/{draft_type}/review)",
}


def _guard_gate(item_id: int) -> None:
    item = approval_flow._find(item_id)
    if item is None:
        return
    kind = str(item.get("kind") or "")
    for prefix in GATED_KIND_PREFIXES:
        if kind.startswith(prefix):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"approval item {item_id} ('{kind}') is a governed human gate; "
                    f"disposition it through {GATE_OWNER[prefix]} so the role check, "
                    "segregation of duties, the written reason and the audit row all apply"
                ),
            )


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
    _guard_gate(item_id)
    try:
        return approval_flow.approve(item_id, req.actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/submissions/{item_id}/reject")
def reject(item_id: int, req: DecisionRequest):
    _guard_gate(item_id)
    # A rejection with no stated reason is not an examinable decision.
    if not (req.reason or "").strip():
        raise HTTPException(status_code=400, detail="a written reason is required to reject a submission")
    try:
        return approval_flow.reject(item_id, req.actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
