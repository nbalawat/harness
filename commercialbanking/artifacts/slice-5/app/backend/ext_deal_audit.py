"""portfolio-qa-sla-audit slice: a deal's chronological audit history.

REQ-042/043/044: audit_trail is already the single, append-only system of
record for every deal's state changes, deterministic calculations, agent
drafts and human decisions — every earlier slice's `_audit` helper writes to
it. This endpoint adds nothing new to write; it is a pure, read-only view
scoped to one deal, newest-first (the audit-view module's stated convention
— see agent-guide.md — and the same ordering the generic audit-log endpoint
in ext_audit.py already uses).

Composition contract:
  * storage  -> db.store only (deals, audit_trail) — no new table
  * scoping  -> optional: an unauthenticated caller (every acceptance call in
                this build) sees the trail unscoped, exactly like GET
                /deals/{id}; a caller presenting a session is scoped through
                the same DEAL_RLS_POLICY ext_deals.py already declares
                (REQ-048), so a relationship manager can't read another RM's
                deal history via this endpoint either
  * routes   -> mounted outside /api/ so main.py's /api/{table} catch-all
                never shadows it
"""
from fastapi import APIRouter, Header, HTTPException

import rls
from db import store
from ext_auth import current_user
from ext_deals import DEAL_RLS_POLICY

router = APIRouter()


def _get_deal(deal_id):
    for row in store.list("deals"):
        if row.get("deal_id") == deal_id:
            return row
    return None


@router.get("/deals/{deal_id}/audit")
def deal_audit(deal_id: str, authorization: str | None = Header(default=None)):
    deal = _get_deal(deal_id)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    actor = current_user(authorization)
    if actor is not None and not rls.scope([deal], actor, DEAL_RLS_POLICY):
        # Same 404-not-403 shape as ext_deals.get_deal — existence of a deal
        # outside your scope is not information this endpoint discloses.
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    entries = [e for e in store.list("audit_trail") if e.get("deal_id") == deal_id]
    entries.sort(key=lambda e: e["id"], reverse=True)
    return entries
