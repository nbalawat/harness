"""Deal intake + pipeline board (REQ-001, REQ-002, REQ-018..021, REQ-026..028,
REQ-041, REQ-042, REQ-051). The walking skeleton: one form, one persisted
Deal, one board.

Registered as explicit routes under /api/ so they resolve before main.py's
generic /api/{table} catch-all (ext_*.py routers are included before that
catch-all is even declared — see main.py's module-load order).
"""
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import forms
import rls
import stages
import tiering
from db import store
from ext_audit import record as audit
from ext_auth import find_user
from models import TABLES

router = APIRouter(prefix="/api")

DEAL_SCHEMA = {
    "borrower_name": {"type": "str", "required": True, "max_len": 200},
    "borrower_industry": {"type": "str", "required": True, "max_len": 100},
    "facility_type": {
        "type": "str",
        "required": True,
        "choices": ["term_loan", "line_of_credit", "cre_mortgage", "sba_7a"],
    },
    "requested_amount": {"type": "float", "required": True},
    "exposure_amount": {"type": "float", "required": True},
    "submitted_by_user_id": {"type": "str", "required": True, "max_len": 100},
}

_RLS_POLICY = {"owner_field": "submitted_by_user_id", "bypass_roles": ["credit_analyst", "senior_credit_officer", "admin"]}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _find_deal(deal_id: str):
    for row in store.list("deals"):
        if str(row["id"]) == str(deal_id):
            return row
    return None


class DealCreateRequest(BaseModel):
    borrower_name: str
    borrower_industry: str
    facility_type: str
    requested_amount: float
    exposure_amount: float
    submitted_by_user_id: str


@router.post("/deals", status_code=201)
def create_deal(req: DealCreateRequest):
    validated = forms.validate(DEAL_SCHEMA, req.model_dump())
    if not validated["ok"]:
        raise HTTPException(status_code=400, detail=validated["errors"])
    cleaned = validated["cleaned"]

    submitter = find_user(cleaned["submitted_by_user_id"])
    if submitter is None:
        raise HTTPException(status_code=404, detail="unknown submitting user")
    if submitter["role"] != "relationship_manager":
        raise HTTPException(status_code=403, detail="only a relationship manager may submit a deal (REQ-020)")

    now = _now()
    deal = store.insert(
        "deals",
        {
            "borrower_name": cleaned["borrower_name"],
            "borrower_industry": cleaned["borrower_industry"],
            "facility_type": cleaned["facility_type"],
            "requested_amount": cleaned["requested_amount"],
            "exposure_amount": cleaned["exposure_amount"],
            "current_stage": stages.machine.initial,
            "assigned_analyst_id": None,
            "submitted_by_user_id": submitter["id"],
            "created_at": now,
            "last_activity_at": now,
            "closed_at": None,
            "is_closed": False,
            "approval_tier": tiering.derive_tier(cleaned["exposure_amount"]),
        },
    )
    entry = audit(
        "deal.created",
        {
            "deal_id": deal["id"],
            "borrower_name": deal["borrower_name"],
            "actor_user_id": submitter["id"],
            "actor_role": submitter["role"],
            "to_stage": deal["current_stage"],
        },
    )
    store.insert(
        "stage_transitions",
        {
            "deal_id": deal["id"],
            "from_stage": None,
            "to_stage": deal["current_stage"],
            "transitioned_by_user_id": submitter["id"],
            "transition_reason": "deal submitted at intake",
            "transitioned_at": now,
        },
    )
    return {**deal, "audit_log_id": entry["id"]}


@router.get("/deals")
def list_deals(as_user_id: str | None = None):
    """RBAC-scoped list (REQ-020, REQ-021, REQ-026, REQ-027): an
    unrecognised or unscoped caller (e.g. an officer-wide board view, or the
    plain board probe) sees every active deal; a known relationship manager
    is scoped to the deals they submitted.
    """
    rows = store.list("deals")
    if not as_user_id:
        return rows
    user = find_user(as_user_id)
    scope_key = user["id"] if user else as_user_id
    return rls.scope(rows, scope_key, _RLS_POLICY)


@router.get("/deals/{deal_id}")
def get_deal(deal_id: str):
    deal = _find_deal(deal_id)
    if deal is None:
        raise HTTPException(status_code=404, detail="unknown deal")
    return deal


@router.get("/pipeline")
def pipeline_board():
    """Deterministic board view (REQ-002): every configured stage, in
    order, with the active deals currently sitting in it. Nothing here is
    agent-produced — a board view has nothing for an agent to add.
    """
    deals = [d for d in store.list("deals") if not d.get("is_closed")]
    by_stage = {stage: [] for stage in stages.STAGES}
    for deal in deals:
        by_stage.setdefault(deal.get("current_stage", "intake"), []).append(deal)
    return {
        "stages": [
            {
                "key": stage,
                "label": stages.stage_label(stage),
                "index": stages.stage_index(stage),
                "count": len(by_stage.get(stage, [])),
                "deals": by_stage.get(stage, []),
            }
            for stage in stages.STAGES
        ],
        "total_active": len(deals),
    }


assert "deals" in TABLES  # fails loudly if the data model is ever renamed under us
