"""ext_tiered_approval_and_sla: slice `tiered-approval-and-sla`.

A credit officer approves, declines (with a controlled adverse-action reason),
or returns a deal from its dossier. Approval authority is enforced
server-side by exposure tier (R-020/R-021/R-022) so a credit analyst cannot
approve above $250,000 and only a senior credit officer (or above) may sign
between $250,000 and $1,000,000 — no agent may ever approve, decline, or
advance a deal (R-023), so this entire module is deterministic code.

The SLA idle register (R-034/R-057) measures every open deal's idle time in
business days (weekends and configured `business_calendar` holidays
excluded) from its last meaningful activity, and lets a credit officer
reassign, return, or acknowledge a stuck deal.

Six of the `deal-underwriting-lifecycle` and `sla-idle-escalation` workflows'
deterministic node handlers are implemented and registered here so their
contracts are real, callable functions per the workflow-authoring
convention: determine_approval_tier (node `tier`), record_approval_decision
(node `record`), record_adverse_action_or_return (node `outcome`),
close_approved_deal (node `close`), compute_business_day_idle_time (node
`measure`), collect_stage_blockers (node `blockers`), and
apply_sla_escalation_action (node `apply`). Like `ext_deal_intake.py`, they
are invoked directly from the REST endpoints below rather than through
workflow_engine.start()/tick() — the nodes upstream of `tier` (spread,
ratios, grade, memo, policy, exceptions) belong to sibling slices built
concurrently on the same foundation, and their handlers may not exist yet in
this slice's own verification run.

This slice inserts its own fixture deals (DEAL-1004, DEAL-1005, DEAL-1006)
directly with an explicit deal_code, exactly as deals_repo.py's docstring
describes for "fixture/seed deals a later slice inserts directly" — those
codes are independent of the next_deal_code() sequence real intake submission
uses, so they never collide with deals filed through /api/deals.
"""
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import assignment
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit
from ext_deal_intake import REQUIRED_DOCUMENT_TYPES

router = APIRouter()

TIER_ANALYST_MAX = 250000
TIER_OFFICER_MAX = 1000000

# Authority ranking used to test "does this actor's role meet or exceed the
# role required to sign at this deal's exposure tier" (R-020/R-021/R-022).
ROLE_RANK = {
    "credit_analyst": 1,
    "senior_credit_officer": 2,
    "credit_committee": 3,
    "admin": 3,
}

# R-033: reassign/return/decline authority belongs to the credit-officer
# tier and above, regardless of exposure — an analyst may only ever approve
# (never decline or return), and only within their own $250k tier.
CAN_DECLINE_OR_RETURN = {"senior_credit_officer", "credit_committee", "admin"}
CAN_APPROVE_ROLES = {"credit_analyst", "senior_credit_officer", "credit_committee", "admin"}

SLA_BUSINESS_DAY_THRESHOLD = 5
ANALYST_POOL = ["analyst@bank.test"]

ADVERSE_ACTION_REASONS = [
    ("INSUFFICIENT_DSCR", "Debt service coverage below the policy floor"),
    ("EXCESSIVE_LEVERAGE", "Leverage above policy guidance"),
    ("INSUFFICIENT_COLLATERAL", "Collateral value does not support the requested exposure"),
    ("WEAK_CASH_FLOW", "Historical cash flow does not support debt service"),
    ("CREDIT_HISTORY", "Adverse credit history on the borrower or guarantor"),
    ("PROHIBITED_INDUSTRY", "Borrower industry is excluded under active lending policy"),
    ("OTHER", "Other reason documented in the free-text detail"),
]


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _user_email(user_id):
    if not user_id:
        return None
    for u in store.list("users"):
        if u["id"] == user_id:
            return u.get("email")
    return None


# ------------------------------------------------------------------------
# workflow-engine handlers
# ------------------------------------------------------------------------

def determine_approval_tier(context):
    """Node `tier`: R-020/R-021/R-022 fixed dollar thresholds — arithmetic,
    never an agent's judgement call."""
    inputs = context.get("inputs", context)
    deal_id = inputs.get("deal_id")
    exposure = float(inputs.get("exposure_amount") or 0)
    if exposure <= TIER_ANALYST_MAX:
        level, role = "credit_analyst_tier", "credit_analyst"
        rule = f"exposure <= ${TIER_ANALYST_MAX:,.0f} (R-020)"
    elif exposure <= TIER_OFFICER_MAX:
        level, role = "senior_credit_officer_tier", "senior_credit_officer"
        rule = f"${TIER_ANALYST_MAX:,.0f} < exposure <= ${TIER_OFFICER_MAX:,.0f} (R-021)"
    else:
        level, role = "credit_committee_tier", "credit_committee"
        rule = f"exposure > ${TIER_OFFICER_MAX:,.0f} (R-022)"
    entry = audit("deal.approval_tier_determined", {
        "deal_id": deal_id,
        "resource_type": "deal",
        "resource_id": deal_id,
        "after": {"required_authority_level": level, "eligible_role": role},
    })
    return {
        "exposure_amount": exposure,
        "required_authority_level": level,
        "eligible_role": role,
        "tier_rule_applied": rule,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("determine_approval_tier", determine_approval_tier)


def record_approval_decision(context):
    """Node `record`: persists the named human's decision. R-024 requires the
    deciding user's identity; R-062 requires a guard against double-deciding,
    which the idempotency_key plus the caller's status check enforce."""
    deal_id = context["deal_id"]
    decision = context["decision"]  # "approved" | "declined" | "returned"
    prior = [a for a in store.list("approvals") if a.get("deal_id") == deal_id]
    idempotency_key = f"{deal_id}:decision:{len(prior) + 1}"
    approval = store.insert("approvals", {
        "deal_id": deal_id,
        "stage": context.get("stage", "tiered_approval"),
        "approval_authority_level": context.get("authority_level_verified"),
        "exposure_amount": context.get("exposure_amount"),
        "approved_by_user_id": context.get("actor_user_id"),
        "decision": decision,
        "decision_notes": context.get("decision_notes"),
        "decided_at": _now(),
    })
    entry = audit("deal.decision_recorded", {
        "deal_id": deal_id,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "approval",
        "resource_id": approval["id"],
        "after": approval,
    })
    return {
        "approval_id": approval["id"],
        "decision": decision,
        "is_approved": decision == "approved",
        "decided_by_user_id": context.get("actor_user_id"),
        "decided_at": approval["decided_at"],
        "authority_level_verified": context.get("authority_level_verified"),
        "idempotency_key": idempotency_key,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_approval_decision", record_approval_decision)


def record_adverse_action_or_return(context):
    """Node `outcome`: R-026/R-063 — a decline reason must be a controlled
    reason code plus required free-text detail, captured at decline time."""
    deal_id = context["deal_id"]
    decision = context["decision"]
    entry = audit("deal.outcome_recorded", {
        "deal_id": deal_id,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "deal",
        "resource_id": deal_id,
        "after": {"decision": decision},
    })
    return {
        "outcome": decision,
        "adverse_action_reason_code": context.get("adverse_action_reason_code"),
        "adverse_action_detail": context.get("adverse_action_detail"),
        "returned_to_stage": context.get("returned_to_stage"),
        "reassigned_to_user_id": context.get("reassigned_to_user_id"),
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_adverse_action_or_return", record_adverse_action_or_return)


def close_approved_deal(context):
    """Node `close`: the final deterministic transition for an approved deal."""
    deal_id = context["deal_id"]
    updated = deals_repo.update_deal(
        deal_id,
        current_stage="closing",
        current_status="approved",
        last_activity_timestamp=_now(),
    )
    entry = audit("deal.closed", {
        "deal_id": deal_id,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "deal",
        "resource_id": deal_id,
        "after": updated,
    })
    return {
        "deal_id": deal_id,
        "final_stage": updated["current_stage"],
        "final_status": updated["current_status"],
        "closed_at": updated["updated_at"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("close_approved_deal", close_approved_deal)


def _active_holidays():
    return {
        row["calendar_date"]
        for row in store.list("business_calendar")
        if row.get("is_business_day") is False
    }


def _business_days_between(start_iso, now):
    """Whole business days elapsed since start_iso, excluding weekends and
    any date the business_calendar marks is_business_day=false (R-057)."""
    start = datetime.datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
    if start.tzinfo is None:
        start = start.replace(tzinfo=datetime.timezone.utc)
    holidays = _active_holidays()
    day = start.date()
    end = now.date()
    count = 0
    cursor = day
    while cursor < end:
        cursor = cursor + datetime.timedelta(days=1)
        if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
            count += 1
    return count


def compute_business_day_idle_time(context):
    """Node `measure`: pure business-day arithmetic — R-034/R-057. Matches
    the SLA dashboard's own math exactly since both call this function."""
    deal = context.get("deal") or context
    deal_id = deal["deal_code"]
    last_activity = deal.get("last_activity_timestamp") or deal.get("updated_at") or deal.get("created_at")
    now = datetime.datetime.now(datetime.timezone.utc)
    idle_days = _business_days_between(last_activity, now)
    return {
        "deal_id": deal_id,
        "idle_business_days": idle_days,
        "sla_breached": idle_days >= SLA_BUSINESS_DAY_THRESHOLD,
        "last_activity_timestamp": last_activity,
        "current_stage": deal.get("current_stage"),
        "assigned_to_user_id": deal.get("assigned_to_user_id"),
    }


workflow_engine.register_handler("compute_business_day_idle_time", compute_business_day_idle_time)


def collect_stage_blockers(context):
    """Node `blockers`: the structured records already on file, not an
    agent's summary of them (R-004 keeps the roster at five agents)."""
    deal_id = context.get("deal_id") or (context.get("deal") or {}).get("deal_code")
    open_exceptions = [e for e in store.list("policy_exceptions") if e.get("deal_id") == deal_id and e.get("status") == "open"]
    pending_reviews = [
        r for r in store.list("_approvals_queue")
        if r.get("status") == "pending" and isinstance(r.get("payload"), dict) and r["payload"].get("deal_id") == deal_id
    ]
    attached = {d["document_type"] for d in store.list("documents") if d.get("deal_id") == deal_id}
    missing_docs = [t for t in REQUIRED_DOCUMENT_TYPES if t not in attached]
    items = []
    if open_exceptions:
        items.append(f"{len(open_exceptions)} open policy exception(s)")
    if pending_reviews:
        items.append(f"{len(pending_reviews)} pending review(s)")
    if missing_docs:
        items.append(f"missing documents: {', '.join(missing_docs)}")
    return {
        "blocking_items": items,
        "open_exception_count": len(open_exceptions),
        "pending_review_count": len(pending_reviews),
        "missing_document_types": missing_docs,
    }


workflow_engine.register_handler("collect_stage_blockers", collect_stage_blockers)


def apply_sla_escalation_action(context):
    """Node `apply`: the officer's reassign / return / acknowledge choice,
    applied by deterministic code and recorded against their identity
    (R-023 bars any agent from this write; R-030 records the human)."""
    deal_id = context["deal_id"]
    action = context["action"]
    actor_user_id = context.get("actor_user_id")
    note = context.get("note") or ""
    reassigned_to_user_id = None
    returned_to_stage = None

    if action == "reassign":
        target_email = context.get("reassign_to") or assignment.round_robin(list(ANALYST_POOL), queue="sla_reassign")
        target_user = identity.resolve_user(target_email, default_role="credit_analyst")
        reassigned_to_user_id = target_user["id"]
        deals_repo.update_deal(deal_id, assigned_to_user_id=reassigned_to_user_id, last_activity_timestamp=_now())
    elif action == "return":
        returned_to_stage = context.get("target_stage") or "document_extraction"
        target_email = context.get("reassign_to") or assignment.round_robin(list(ANALYST_POOL), queue="sla_return")
        target_user = identity.resolve_user(target_email, default_role="credit_analyst")
        reassigned_to_user_id = target_user["id"]
        store.insert("deal_returns", {
            "deal_id": deal_id,
            "returned_from_stage": context.get("current_stage"),
            "returned_to_stage": returned_to_stage,
            "returned_by_user_id": actor_user_id,
            "reason": note or "SLA escalation return",
            "reassigned_to_user_id": reassigned_to_user_id,
            "created_at": _now(),
        })
        deals_repo.update_deal(
            deal_id,
            current_stage=returned_to_stage,
            current_status="returned_for_rework",
            assigned_to_user_id=reassigned_to_user_id,
            last_activity_timestamp=_now(),
        )
    elif action == "acknowledge":
        pass  # a note only — the SLA clock is not reset by acknowledging alone
    else:
        raise HTTPException(status_code=400, detail=f"unknown escalation action '{action}'")

    entry = audit("deal.sla_escalation_applied", {
        "deal_id": deal_id,
        "actor_user_id": actor_user_id,
        "resource_type": "deal",
        "resource_id": deal_id,
        "after": {"action": action, "note": note, "reassigned_to_user_id": reassigned_to_user_id, "returned_to_stage": returned_to_stage},
    })
    return {
        "action_taken": action,
        "reassigned_to_user_id": reassigned_to_user_id,
        "returned_to_stage": returned_to_stage,
        "decided_by_user_id": actor_user_id,
        "note": note,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("apply_sla_escalation_action", apply_sla_escalation_action)


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

class ApproveRequest(BaseModel):
    acting_user_email: str
    decision_notes: str | None = None


class DeclineRequest(BaseModel):
    acting_user_email: str
    reason_code: str
    reason_detail: str


class ReturnRequest(BaseModel):
    acting_user_email: str
    reason: str
    target_stage: str | None = None


class SlaEscalateRequest(BaseModel):
    acting_user_email: str
    action: str  # "reassign" | "return" | "acknowledge"
    note: str | None = None
    target_stage: str | None = None
    reassign_to: str | None = None


def _require_decision_actor(email, decided_field):
    actor = identity.resolve_user(email, default_role="credit_analyst")
    if actor is None or actor.get("role") not in CAN_APPROVE_ROLES:
        raise HTTPException(status_code=403, detail=f"role of '{email}' lacks any {decided_field} authority")
    return actor


def _already_decided(deal):
    return deal.get("current_status") in ("approved", "declined", "returned_for_rework", "closed")


@router.post("/api/deals/{deal_code}/approve")
def approve_deal(deal_code: str, req: ApproveRequest):
    deal = _deal_or_404(deal_code)
    actor = _require_decision_actor(req.acting_user_email, "approval")
    if _already_decided(deal):
        raise HTTPException(status_code=409, detail=f"deal {deal_code} already has a recorded decision")

    tier = determine_approval_tier({"inputs": {"deal_id": deal_code, "exposure_amount": deal.get("exposure_amount")}})
    actor_rank = ROLE_RANK.get(actor.get("role"), 0)
    required_rank = ROLE_RANK[tier["eligible_role"]]
    if actor_rank < required_rank:
        raise HTTPException(
            status_code=403,
            detail=(
                f"role '{actor['role']}' lacks approval authority for a ${tier['exposure_amount']:,.0f} deal "
                f"— requires {tier['eligible_role']} or higher ({tier['tier_rule_applied']})"
            ),
        )

    record = record_approval_decision({
        "deal_id": deal_code,
        "decision": "approved",
        "actor_user_id": actor["id"],
        "authority_level_verified": tier["required_authority_level"],
        "exposure_amount": tier["exposure_amount"],
        "decision_notes": req.decision_notes,
        "stage": deal.get("current_stage"),
    })
    record_adverse_action_or_return({"deal_id": deal_code, "decision": "approved", "actor_user_id": actor["id"]})
    closed = close_approved_deal({"deal_id": deal_code, "actor_user_id": actor["id"]})

    return {
        "deal_id": deal_code,
        "decision": "approved",
        "message": f"Deal {deal_code} approved by {actor['email']} ({actor['role']}).",
        "approved_by_role": actor["role"],
        "approved_by_email": actor["email"],
        "required_authority_level": tier["required_authority_level"],
        "approval_id": record["approval_id"],
        "final_stage": closed["final_stage"],
        "final_status": closed["final_status"],
    }


@router.post("/api/deals/{deal_code}/decline")
def decline_deal(deal_code: str, req: DeclineRequest):
    deal = _deal_or_404(deal_code)
    actor = _require_decision_actor(req.acting_user_email, "decline")
    if actor.get("role") not in CAN_DECLINE_OR_RETURN:
        raise HTTPException(status_code=403, detail=f"role '{actor['role']}' lacks decline authority — a senior credit officer or above must decide")
    if _already_decided(deal):
        raise HTTPException(status_code=409, detail=f"deal {deal_code} already has a recorded decision")

    reasons = {r["reason_code"]: r for r in store.list("adverse_action_reasons") if r.get("is_active", True)}
    if req.reason_code not in reasons:
        raise HTTPException(status_code=400, detail=f"unknown reason_code '{req.reason_code}' — must be one of {sorted(reasons)}")
    if not req.reason_detail or not req.reason_detail.strip():
        raise HTTPException(status_code=400, detail="reason_detail is required to document a decline")

    tier = determine_approval_tier({"inputs": {"deal_id": deal_code, "exposure_amount": deal.get("exposure_amount")}})
    record_approval_decision({
        "deal_id": deal_code,
        "decision": "declined",
        "actor_user_id": actor["id"],
        "authority_level_verified": tier["required_authority_level"],
        "exposure_amount": tier["exposure_amount"],
        "decision_notes": req.reason_detail,
        "stage": deal.get("current_stage"),
    })
    record_adverse_action_or_return({
        "deal_id": deal_code,
        "decision": "declined",
        "actor_user_id": actor["id"],
        "adverse_action_reason_code": req.reason_code,
        "adverse_action_detail": req.reason_detail,
    })
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="declined",
        current_status="declined",
        decline_reason_code=req.reason_code,
        decline_reason_detail=req.reason_detail,
        last_activity_timestamp=_now(),
    )
    return {
        "deal_id": deal_code,
        "decision": "declined",
        "message": f"Deal {deal_code} declined by {actor['email']} ({actor['role']}): {req.reason_code}.",
        "reason_code": req.reason_code,
        "reason_detail": req.reason_detail,
        "current_stage": updated["current_stage"],
    }


@router.post("/api/deals/{deal_code}/return")
def return_deal(deal_code: str, req: ReturnRequest):
    deal = _deal_or_404(deal_code)
    actor = _require_decision_actor(req.acting_user_email, "return")
    if actor.get("role") not in CAN_DECLINE_OR_RETURN:
        raise HTTPException(status_code=403, detail=f"role '{actor['role']}' lacks return authority — a senior credit officer or above must decide")
    if not req.reason or not req.reason.strip():
        raise HTTPException(status_code=400, detail="a written reason is required to return a deal")

    target_stage = req.target_stage or "document_extraction"
    assignee_email = assignment.round_robin(list(ANALYST_POOL), queue="return_queue")
    assignee = identity.resolve_user(assignee_email, default_role="credit_analyst")
    store.insert("deal_returns", {
        "deal_id": deal_code,
        "returned_from_stage": deal.get("current_stage"),
        "returned_to_stage": target_stage,
        "returned_by_user_id": actor["id"],
        "reason": req.reason,
        "reassigned_to_user_id": assignee["id"],
        "created_at": _now(),
    })
    updated = deals_repo.update_deal(
        deal_code,
        current_stage=target_stage,
        current_status="returned_for_rework",
        assigned_to_user_id=assignee["id"],
        last_activity_timestamp=_now(),
    )
    audit("deal.returned", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": {"current_stage": deal.get("current_stage")},
        "after": updated,
    })
    return {
        "deal_id": deal_code,
        "outcome": "returned",
        "returned_to_stage": target_stage,
        "reassigned_to_user_id": assignee["id"],
        "message": f"Deal {deal_code} returned to {target_stage} by {actor['email']}.",
    }


@router.get("/api/deals/{deal_code}/approvals")
def list_approvals(deal_code: str):
    _deal_or_404(deal_code)
    return [a for a in store.list("approvals") if a.get("deal_id") == deal_code]


@router.get("/api/adverse-action-reasons")
def list_adverse_action_reasons():
    return [r for r in store.list("adverse_action_reasons") if r.get("is_active", True)]


@router.get("/api/sla/idle")
def sla_idle():
    now = datetime.datetime.now(datetime.timezone.utc)
    deals = [d for d in deals_repo.all_current_deals() if d.get("current_status") not in ("approved", "declined")]
    idle_deals = []
    exposure_at_rest = 0.0
    for deal in deals:
        measured = compute_business_day_idle_time({"deal": deal})
        if not measured["sla_breached"]:
            continue
        owner_email = _user_email(deal.get("assigned_to_user_id")) or "unassigned"
        exposure = float(deal.get("exposure_amount") or 0)
        exposure_at_rest += exposure
        idle_deals.append({
            "deal_id": measured["deal_id"],
            "borrower_name": deal.get("borrower_name"),
            "current_stage": measured["current_stage"],
            "business_days_idle": measured["idle_business_days"],
            "last_activity_timestamp": measured["last_activity_timestamp"],
            "exposure_amount": exposure,
            "escalation_owner": owner_email,
        })
    idle_deals.sort(key=lambda d: d["business_days_idle"], reverse=True)
    by_stage = {}
    by_owner = {}
    for d in idle_deals:
        by_stage[d["current_stage"] or "unknown"] = by_stage.get(d["current_stage"] or "unknown", 0) + 1
        by_owner[d["escalation_owner"]] = by_owner.get(d["escalation_owner"], 0) + 1
    approaching = [
        d for d in deals
        if compute_business_day_idle_time({"deal": d})["idle_business_days"] in (SLA_BUSINESS_DAY_THRESHOLD - 1,)
    ]
    return {
        "idle_deals": idle_deals,
        "total_active_deals": len(deals),
        "stats": {
            "past_service_line_count": len(idle_deals),
            "exposure_at_rest": exposure_at_rest,
            "longest_idle_business_days": idle_deals[0]["business_days_idle"] if idle_deals else 0,
            "longest_idle_deal_id": idle_deals[0]["deal_id"] if idle_deals else None,
            "approaching_service_line_count": len(approaching),
        },
        "idle_by_stage": by_stage,
        "idle_by_owner": by_owner,
    }


@router.post("/api/deals/{deal_code}/sla-escalate")
def sla_escalate(deal_code: str, req: SlaEscalateRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.resolve_user(req.acting_user_email, default_role="credit_analyst")
    if actor is None or actor.get("role") not in CAN_DECLINE_OR_RETURN:
        raise HTTPException(status_code=403, detail=f"role '{actor.get('role') if actor else None}' lacks SLA-escalation authority — a credit officer must decide")

    blockers = collect_stage_blockers({"deal_id": deal_code})
    result = apply_sla_escalation_action({
        "deal_id": deal_code,
        "action": req.action,
        "actor_user_id": actor["id"],
        "note": req.note,
        "target_stage": req.target_stage,
        "reassign_to": req.reassign_to,
        "current_stage": deal.get("current_stage"),
    })
    return {**result, "deal_id": deal_code, "blocking_items": blockers["blocking_items"]}


# ------------------------------------------------------------------------
# fixtures — see module docstring: explicit deal_code, independent of
# next_deal_code()'s sequence.
# ------------------------------------------------------------------------

def _seed_reason_codes():
    existing = {r["reason_code"] for r in store.list("adverse_action_reasons")}
    for code, label in ADVERSE_ACTION_REASONS:
        if code in existing:
            continue
        store.insert("adverse_action_reasons", {
            "reason_code": code,
            "reason_label": label,
            "is_active": True,
        })


def seed_fixture_deals(force=False):
    """Insert (or, with force=True, freshly re-insert) the DEAL-1004..1007
    fixtures. deals_repo rows are event-sourced — inserting again with the
    same deal_code just becomes the new "current" row — so `force` is how
    the backend test suite restores known-good fixture state for this
    module's own tests after `test_deal_intake_and_triage.py`'s deal
    creations advance the shared next_deal_code() sequence far enough to
    reuse (and shadow) these same human-readable codes within one pytest
    process. A live app boot never hits this: only slice-1's acceptance
    check files a real deal (DEAL-1001), so the sequence never reaches 1004+."""
    if not force and deals_repo.get_deal("DEAL-1004") is not None:
        return  # already seeded this process

    analyst = identity.resolve_user("analyst@bank.test", default_role="credit_analyst")
    officer = identity.resolve_user("officer@bank.test", default_role="senior_credit_officer")
    now = _now()
    stale = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=14)).isoformat()

    store.insert("deals", {
        "deal_code": "DEAL-1004",
        "borrower_name": "Foxglove Millwork LLC",
        "borrower_industry": "manufacturing",
        "borrower_entity_id": None,
        "requested_amount": 500000,
        "exposure_amount": 500000,
        "current_stage": "tiered_approval",
        "current_status": "pending_decision",
        "created_by_user_id": analyst["id"],
        "assigned_to_user_id": officer["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": now,
        "created_at": now,
        "updated_at": now,
    })
    store.insert("deals", {
        "deal_code": "DEAL-1005",
        "borrower_name": "Pemberton Cold Storage",
        "borrower_industry": "logistics",
        "borrower_entity_id": None,
        "requested_amount": 300000,
        "exposure_amount": 300000,
        "current_stage": "financial_spreading",
        "current_status": "in_progress",
        "created_by_user_id": analyst["id"],
        "assigned_to_user_id": analyst["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": stale,
        "created_at": stale,
        "updated_at": stale,
    })
    store.insert("deals", {
        "deal_code": "DEAL-1006",
        "borrower_name": "Kestrel Transit Repair",
        "borrower_industry": "trucking",
        "borrower_entity_id": None,
        "requested_amount": 150000,
        "exposure_amount": 150000,
        "current_stage": "tiered_approval",
        "current_status": "pending_decision",
        "created_by_user_id": analyst["id"],
        "assigned_to_user_id": officer["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": now,
        "created_at": now,
        "updated_at": now,
    })
    # A second stale deal, distinct from DEAL-1005, so demo/tests can exercise
    # return/reassign actions without disturbing the DEAL-1005 idle-register
    # fixture the acceptance check reads.
    store.insert("deals", {
        "deal_code": "DEAL-1007",
        "borrower_name": "Wrenfield Auto Body",
        "borrower_industry": "auto_repair",
        "borrower_entity_id": None,
        "requested_amount": 180000,
        "exposure_amount": 180000,
        "current_stage": "document_extraction",
        "current_status": "in_progress",
        "created_by_user_id": analyst["id"],
        "assigned_to_user_id": analyst["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": stale,
        "created_at": stale,
        "updated_at": stale,
    })
    audit("deal.fixture_seeded", {"resource_type": "deal", "resource_id": "DEAL-1004,DEAL-1005,DEAL-1006,DEAL-1007"})


_seed_reason_codes()
seed_fixture_deals()
