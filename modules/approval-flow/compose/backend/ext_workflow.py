"""approval-flow endpoints (under /workflow — never elsewhere).

These endpoints resolve a HUMAN gate, so they must not accept a bare string as
identity. When the app provides an identity layer, the acting_user_email is
resolved against it and fails closed (401 absent / 403 unknown persona) — a
non-empty string is never enough. ROLE and segregation-of-duties are
app-specific and remain the owning slice's responsibility (register an
authorizer, or guard these before exposing them): see build-expertise.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import approval_flow

try:  # the app's identity layer, when composed
    from identity import require_actor as _require_actor
except Exception:  # standalone module / no identity layer
    _require_actor = None

router = APIRouter(prefix="/workflow")


def _soft_gate(acting_user_email: str | None) -> None:
    """Enforce identity only when the app provides an identity layer (the module
    stays usable standalone). In an identity-gated app, sensitive reads/writes
    fail closed (401 absent / 403 unknown persona)."""
    if _require_actor is not None:
        _require_actor(acting_user_email)


def _resolve_actor(acting_user_email: str | None) -> str:
    """A gate decision must name a REAL actor. Fail closed on absent identity;
    when the app has an identity layer, the email must resolve to a provisioned
    persona (require_actor raises 401/403), never just be non-empty."""
    if not acting_user_email:
        raise HTTPException(status_code=401, detail="a decision requires acting_user_email")
    if _require_actor is not None:
        return _require_actor(acting_user_email).get("email", acting_user_email)
    return acting_user_email


class SubmitRequest(BaseModel):
    kind: str
    payload: dict
    by: str
    acting_user_email: str | None = None


class DecisionRequest(BaseModel):
    acting_user_email: str | None = None  # the decision's identity; fail-closed if absent
    reason: str = ""


@router.post("/submissions")
def submit(req: SubmitRequest):
    _soft_gate(req.acting_user_email)
    return approval_flow.submit(req.kind, req.payload, req.by)


@router.get("/submissions/pending")
def pending(acting_user_email: str | None = Query(default=None)):
    # The pending queue embeds case PII in each item's rendered gate question —
    # a sensitive read, gated by identity when the app has one.
    _soft_gate(acting_user_email)
    return approval_flow.pending()


@router.post("/submissions/{item_id}/approve")
def approve(item_id: int, req: DecisionRequest):
    actor = _resolve_actor(req.acting_user_email)
    try:
        return approval_flow.approve(item_id, actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/submissions/{item_id}/reject")
def reject(item_id: int, req: DecisionRequest):
    actor = _resolve_actor(req.acting_user_email)
    try:
        return approval_flow.reject(item_id, actor, req.reason)
    except approval_flow.IllegalTransition as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
