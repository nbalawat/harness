"""ext_tiered_approval_and_sla: slice `tiered-approval-and-sla`.

The credit officer's decision desk and the service line.

  * TIERED APPROVAL (R-020/R-021/R-022/R-023/R-024/R-026/R-062/R-063)
    A deal is approved, declined with a controlled adverse-action reason, or
    returned to an earlier stage by a *named human*. Approval authority is a
    function of exposure and is enforced SERVER-SIDE: below
    identity.MAX_APPROVAL_EXPOSURE a credit analyst holds authority; above it
    only a senior credit officer (or admin) does, so an analyst can never
    approve above $250,000 no matter what the client sends. Decisions are
    idempotent on (deal, decision, decider) so a double-submit cannot write
    two approvals.

  * ADVERSE ACTION (R-021/R-047)
    A decline must name a reason code drawn from the controlled
    `adverse_action_reasons` register plus written detail — free-text-only
    declines are rejected with the list of valid codes.

  * THE IDLE REGISTER (R-033/R-034/R-057)
    `GET /api/sla/idle` measures idle time in BUSINESS days (weekends and the
    seeded bank-holiday calendar excluded) from each deal's last meaningful
    activity, and lists everything past the five-business-day service line
    with the work blocking it and the officer it escalates to.

Workflow contracts implemented here (workflows/workflows.json):
  deal-underwriting-lifecycle : determine_approval_tier, record_approval_decision,
                                record_adverse_action_or_return, close_approved_deal
  sla-idle-escalation         : compute_business_day_idle_time, collect_stage_blockers,
                                apply_sla_escalation_action  (every node of that
                                workflow belongs to this slice, so
                                POST /api/sla/{deal}/escalate really does drive
                                the run start -> human park -> apply to completion)

No financial or clock arithmetic is delegated to an LLM: every number on this
surface is computed in deterministic Python.
"""
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

# ---------------------------------------------------------------------------
# Policy constants — the tier ladder and the service line.
# ---------------------------------------------------------------------------

SLA_IDLE_BUSINESS_DAYS = 5  # a deal crosses the line at its sixth idle business day
APPROACHING_FROM = 3

# Ordered ladder: the first tier whose ceiling covers the exposure applies.
APPROVAL_TIERS = (
    {
        "level": "credit_analyst",
        "max_exposure": identity.MAX_APPROVAL_EXPOSURE,
        "roles": (identity.CREDIT_ANALYST, identity.SENIOR_CREDIT_OFFICER, identity.ADMIN),
    },
    {
        "level": "senior_credit_officer",
        "max_exposure": None,
        "roles": (identity.SENIOR_CREDIT_OFFICER, identity.ADMIN),
    },
)

RETURNABLE_STAGES = (
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "tiered_approval",
)

REQUIRED_DOCUMENT_TYPES = ("balance_sheet", "income_statement", "tax_return")

FINAL_STATUSES = {"approved", "declined"}


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(dt=None):
    return (dt or _now()).isoformat()


# ---------------------------------------------------------------------------
# Reference data (read-only lookups the UI reads through the allowlisted
# generic /api/<table> route). Seeded once at import; never re-seeded.
# ---------------------------------------------------------------------------

ADVERSE_ACTION_REASONS = (
    ("INSUFFICIENT_DSCR", "Debt service coverage below the policy floor"),
    ("EXCESSIVE_LEVERAGE", "Leverage above the policy ceiling"),
    ("INSUFFICIENT_COLLATERAL", "Collateral coverage below the required advance rate"),
    ("PROHIBITED_INDUSTRY", "Borrower operates in a prohibited industry"),
    ("INCOMPLETE_DOCUMENTATION", "Required financial documentation not provided"),
    ("UNRESOLVED_POLICY_EXCEPTION", "Open policy exception was not waived"),
    ("ADVERSE_CREDIT_HISTORY", "Adverse credit history on the borrower or principals"),
)

# 2026 bank holidays — the non-business days behind every idle count.
BANK_HOLIDAYS_2026 = (
    ("2026-01-01", "New Year's Day"),
    ("2026-01-19", "Martin Luther King Jr. Day"),
    ("2026-02-16", "Presidents' Day"),
    ("2026-05-25", "Memorial Day"),
    ("2026-06-19", "Juneteenth"),
    ("2026-07-03", "Independence Day (observed)"),
    ("2026-09-07", "Labor Day"),
    ("2026-10-12", "Columbus Day"),
    ("2026-11-11", "Veterans Day"),
    ("2026-11-26", "Thanksgiving Day"),
    ("2026-12-25", "Christmas Day"),
)


def _seed_reference_data():
    if not store.list("adverse_action_reasons"):
        for code, label in ADVERSE_ACTION_REASONS:
            store.insert("adverse_action_reasons", {
                "reason_code": code,
                "reason_label": label,
                "is_active": True,
                "created_at": _iso(),
            })
    if not store.list("business_calendar"):
        for day, name in BANK_HOLIDAYS_2026:
            store.insert("business_calendar", {
                "calendar_date": day,
                "is_business_day": False,
                "holiday_name": name,
                "created_at": _iso(),
            })


def active_reason_codes():
    return [r["reason_code"] for r in store.list("adverse_action_reasons") if r.get("is_active", True)]


def _holidays():
    return {
        str(r.get("calendar_date"))
        for r in store.list("business_calendar")
        if not r.get("is_business_day", True)
    }


# ---------------------------------------------------------------------------
# Deterministic business-day clock. No LLM, no wall-clock guessing.
# ---------------------------------------------------------------------------

def _parse(iso_value):
    if not iso_value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(iso_value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def business_days_between(start_iso, end=None):
    """Business days strictly after `start_iso`'s date, through `end`'s date."""
    start = _parse(start_iso)
    if start is None:
        return 0
    end = end or _now()
    holidays = _holidays()
    day = start.date() + datetime.timedelta(days=1)
    last = end.date()
    count = 0
    guard = 0
    while day <= last and guard < 3650:
        if day.weekday() < 5 and day.isoformat() not in holidays:
            count += 1
        day += datetime.timedelta(days=1)
        guard += 1
    return count


# ---------------------------------------------------------------------------
# Fixtures: the deals this slice's desk operates on. Inserted with explicit
# deal codes so they never consume the intake sequence (see deals_repo).
# ---------------------------------------------------------------------------

def _fixture_deal(code, **fields):
    if deals_repo.get_deal(code) is not None:
        return
    rm = identity.resolve_user("rm@bank.test", default_role=identity.RELATIONSHIP_MANAGER)
    idle_days = fields.pop("idle_days", 1)
    owner_email = fields.pop("owner_email", "analyst@bank.test")
    owner = identity.resolve_user(owner_email, default_role=identity.CREDIT_ANALYST) if owner_email else None
    last_activity = _iso(_now() - datetime.timedelta(days=idle_days))
    row = {
        "deal_code": code,
        "borrower_entity_id": None,
        "current_status": "awaiting_approval",
        "created_by_user_id": rm["id"],
        "assigned_to_user_id": owner["id"] if owner is not None else None,
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": last_activity,
        "created_at": _iso(_now() - datetime.timedelta(days=idle_days + 10)),
        "updated_at": last_activity,
    }
    row.update(fields)
    store.insert("deals", row)


def _seed_desk_fixtures():
    # Awaiting a tiered decision — exposure above the analyst ceiling.
    _fixture_deal(
        "DEAL-1004",
        borrower_name="Ironvale Fabrication",
        borrower_industry="metal_fabrication",
        requested_amount=900000,
        exposure_amount=900000,
        current_stage="tiered_approval",
        current_status="awaiting_approval",
        risk_grade=5,
        idle_days=2,
    )
    # Past the service line — the register's headline case.
    _fixture_deal(
        "DEAL-1005",
        borrower_name="Vellum Bookbinding Co.",
        borrower_industry="printing",
        requested_amount=88000,
        exposure_amount=88000,
        current_stage="document_extraction",
        current_status="documents_pending",
        idle_days=12,
    )
    # Awaiting a tiered decision — the adverse-action case.
    _fixture_deal(
        "DEAL-1006",
        borrower_name="Quarry Road Concrete",
        borrower_industry="construction_materials",
        requested_amount=1480000,
        exposure_amount=1480000,
        current_stage="tiered_approval",
        current_status="awaiting_approval",
        risk_grade=8,
        idle_days=3,
    )
    _fixture_deal(
        "DEAL-1041",
        borrower_name="Lantern Bay Hospitality",
        borrower_industry="hospitality",
        requested_amount=755000,
        exposure_amount=755000,
        current_stage="policy_compliance",
        current_status="exception_raised",
        owner_email="officer@bank.test",
        idle_days=15,
    )
    _fixture_deal(
        "DEAL-1042",
        borrower_name="Bluewater Marine Supply",
        borrower_industry="marine_wholesale",
        requested_amount=395000,
        exposure_amount=395000,
        current_stage="risk_grading",
        current_status="spread_accepted",
        idle_days=11,
    )
    # Inside the line but approaching it.
    _fixture_deal(
        "DEAL-1043",
        borrower_name="Copper Kettle Catering",
        borrower_industry="food_service",
        requested_amount=70000,
        exposure_amount=70000,
        current_stage="intake",
        current_status="documents_pending",
        owner_email=None,
        idle_days=6,
    )


_seed_reference_data()
_seed_desk_fixtures()


# ---------------------------------------------------------------------------
# Authority: the exposure tier ladder, enforced server-side.
# ---------------------------------------------------------------------------

def tier_for(exposure_amount):
    amount = float(exposure_amount or 0)
    for tier in APPROVAL_TIERS:
        ceiling = tier["max_exposure"]
        if ceiling is None or amount <= float(ceiling):
            return tier
    return APPROVAL_TIERS[-1]


def _authority_or_403(actor, deal, what):
    """The tier gate. `actor` has already been identified and permissioned."""
    exposure = float(deal.get("exposure_amount") or deal.get("requested_amount") or 0)
    tier = tier_for(exposure)
    role = actor.get("role")
    if role not in tier["roles"]:
        raise HTTPException(
            status_code=403,
            detail=(
                f"role '{role}' holds approval authority only to "
                f"${identity.MAX_APPROVAL_EXPOSURE:,.0f}; {deal['deal_code']} at "
                f"${exposure:,.0f} requires {tier['level']} authority to {what}"
            ),
        )
    return tier


def _approver_or_403(email, deal, what="approve this deal"):
    """Identify the caller, then gate it on the exposure tier.

    The ladder IS the authority model for approval: below the ceiling a credit
    analyst holds authority (it has `deal.recommend`), above it only a senior
    credit officer or admin does. Both checks are server-side and default-deny,
    so no client-supplied role or amount can widen them.

    Decline and return are NOT on this path: an adverse-action notice and a
    stage reversal are officer acts, guarded by the `deal.decline` /
    `deal.return` permissions before the same tier gate runs.
    """
    actor = identity.require_actor(email, action=what)
    tier = _authority_or_403(actor, deal, what)
    entitled = identity.has_permission(actor, "deal.approve") or (
        tier["level"] == "credit_analyst" and identity.has_permission(actor, "deal.recommend")
    )
    if not entitled:
        raise HTTPException(
            status_code=403,
            detail=f"role '{actor.get('role')}' lacks the authority to {what}",
        )
    return actor, tier


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _user_email(user_id):
    for u in store.list("users"):
        if u.get("id") == user_id:
            return u.get("email")
    return None


def _idempotency_key(deal_code, decision, user_id):
    return f"{deal_code}:{decision}:{user_id}"


def _existing_approval(key):
    for row in store.list("approvals"):
        if row.get("idempotency_key") == key:
            return row
    return None


def _decided_approval(deal_code):
    rows = [
        r for r in store.list("approvals")
        if r.get("deal_id") == deal_code and r.get("decision") in ("approved", "declined")
    ]
    return rows[-1] if rows else None


# ---------------------------------------------------------------------------
# Workflow handlers — deal-underwriting-lifecycle (tier / record / outcome / close)
# ---------------------------------------------------------------------------

def determine_approval_tier(context):
    """Node `tier`: which authority level this exposure demands."""
    inputs = context.get("inputs", context) or {}
    deal_code = (context.get("intake") or {}).get("deal_id") or inputs.get("deal_id")
    deal = deals_repo.get_deal(deal_code) if deal_code else None
    exposure = float(
        (deal or {}).get("exposure_amount")
        or inputs.get("exposure_amount")
        or 0
    )
    tier = tier_for(exposure)
    entry = audit("approval.tier_determined", {
        "deal_id": deal_code,
        "actor_user_id": inputs.get("acting_user_email") or "system",
        "resource_type": "deal",
        "resource_id": deal_code,
        "after": {"exposure_amount": exposure, "required_authority_level": tier["level"]},
    }, actor=str(inputs.get("acting_user_email") or "system"))
    return {
        "exposure_amount": exposure,
        "required_authority_level": tier["level"],
        "eligible_role": tier["level"],
        "tier_rule_applied": (
            f"exposure <= ${identity.MAX_APPROVAL_EXPOSURE:,.0f} -> credit_analyst; "
            f"above -> senior_credit_officer"
        ),
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("determine_approval_tier", determine_approval_tier)


def _record_decision(deal, actor, decision, notes, tier):
    """The one write path for an approval/decline row. Idempotent."""
    key = _idempotency_key(deal["deal_code"], decision, actor["id"])
    existing = _existing_approval(key)
    if existing is not None:
        return existing, True

    # approvals go through approval-flow, never an ad-hoc status field
    item = approval_flow.submit(
        "credit-decision",
        {
            "deal_id": deal["deal_code"],
            "exposure_amount": deal.get("exposure_amount"),
            "required_authority_level": tier["level"],
        },
        submitted_by=actor["email"],
    )
    if decision == "approved":
        approval_flow.approve(item["id"], actor["email"], reason=notes or "")
    else:
        approval_flow.reject(item["id"], actor["email"], reason=notes or "")

    row = store.insert("approvals", {
        "deal_id": deal["deal_code"],
        "stage": deal.get("current_stage"),
        "approval_authority_level": tier["level"],
        "exposure_amount": deal.get("exposure_amount"),
        "approved_by_user_id": actor["id"],
        "decision": decision,
        "decision_notes": notes,
        "decided_at": _iso(),
        "created_at": _iso(),
        "idempotency_key": key,
        "approval_queue_id": item["id"],
        "decided_by_email": actor["email"],
        "authority_level_verified": True,
    })
    return row, False


def record_approval_decision(context):
    """Node `record`: persist the named human's decision on the deal."""
    inputs = context.get("inputs", context) or {}
    deal_code = (context.get("intake") or {}).get("deal_id") or inputs.get("deal_id")
    deal = _deal_or_404(deal_code)
    actor, tier = _approver_or_403(inputs.get("acting_user_email"), deal)
    decision = inputs.get("decision") or "approved"
    row, _ = _record_decision(deal, actor, decision, inputs.get("decision_notes"), tier)
    entry = audit("deal.decision_recorded", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "approval",
        "resource_id": row["id"],
        "after": {"decision": decision, "authority_level": tier["level"]},
    }, actor=actor["email"])
    return {
        "approval_id": row["id"],
        "decision": row["decision"],
        "is_approved": row["decision"] == "approved",
        "decided_by_user_id": actor["id"],
        "decided_at": row["decided_at"],
        "authority_level_verified": True,
        "idempotency_key": row["idempotency_key"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_approval_decision", record_approval_decision)


def record_adverse_action_or_return(context):
    """Node `outcome`: the adverse-action / return leg of the decision."""
    inputs = context.get("inputs", context) or {}
    deal_code = (context.get("intake") or {}).get("deal_id") or inputs.get("deal_id")
    outcome = inputs.get("outcome") or "approved"
    reason_code = inputs.get("adverse_action_reason_code")
    detail = inputs.get("adverse_action_detail")
    returned_to = inputs.get("returned_to_stage")
    reassigned = inputs.get("reassigned_to_user_id")
    entry = audit("deal.outcome_recorded", {
        "deal_id": deal_code,
        "actor_user_id": inputs.get("acting_user_email") or "system",
        "resource_type": "deal",
        "resource_id": deal_code,
        "after": {
            "outcome": outcome,
            "adverse_action_reason_code": reason_code,
            "returned_to_stage": returned_to,
        },
    }, actor=str(inputs.get("acting_user_email") or "system"))
    return {
        "outcome": outcome,
        "adverse_action_reason_code": reason_code,
        "adverse_action_detail": detail,
        "returned_to_stage": returned_to,
        "reassigned_to_user_id": reassigned,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_adverse_action_or_return", record_adverse_action_or_return)


def close_approved_deal(context):
    """Node `close`: move an approved deal into closing, deterministically."""
    inputs = context.get("inputs", context) or {}
    deal_code = (context.get("intake") or {}).get("deal_id") or inputs.get("deal_id")
    deal = _deal_or_404(deal_code)
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="closing",
        current_status="approved",
        last_activity_timestamp=_iso(),
    )
    entry = audit("deal.closed_approved", {
        "deal_id": deal_code,
        "actor_user_id": inputs.get("acting_user_email") or "system",
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": {"current_stage": deal.get("current_stage"), "current_status": deal.get("current_status")},
        "after": {"current_stage": "closing", "current_status": "approved"},
    }, actor=str(inputs.get("acting_user_email") or "system"))
    return {
        "deal_id": deal_code,
        "final_stage": updated["current_stage"],
        "final_status": updated["current_status"],
        "closed_at": updated["updated_at"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("close_approved_deal", close_approved_deal)


# ---------------------------------------------------------------------------
# Workflow handlers — sla-idle-escalation (every node of that workflow is ours)
# ---------------------------------------------------------------------------

def compute_business_day_idle_time(context):
    """Node `measure`: idle time in business days — arithmetic, never an LLM."""
    inputs = context.get("inputs", context) or {}
    deal_code = inputs.get("deal_id")
    deal = _deal_or_404(deal_code)
    last_activity = deal.get("last_activity_timestamp") or deal.get("updated_at") or deal.get("created_at")
    idle = business_days_between(last_activity)
    return {
        "deal_id": deal_code,
        "idle_business_days": idle,
        "sla_breached": idle > SLA_IDLE_BUSINESS_DAYS,
        "last_activity_timestamp": last_activity,
        "current_stage": deal.get("current_stage"),
        "assigned_to_user_id": deal.get("assigned_to_user_id"),
    }


workflow_engine.register_handler("compute_business_day_idle_time", compute_business_day_idle_time)


def _blockers_for(deal_code, stage):
    missing = sorted(
        set(REQUIRED_DOCUMENT_TYPES)
        - {d.get("document_type") for d in store.list("documents") if d.get("deal_id") == deal_code}
    )
    open_exceptions = [
        e for e in store.list("policy_exceptions")
        if e.get("deal_id") == deal_code and e.get("status") not in ("waived", "resolved", "closed")
    ]
    pending_reviews = [
        o for o in store.list("agent_outputs")
        if o.get("deal_id") == deal_code
        and not any(
            r.get("agent_output_id") == o.get("id") for r in store.list("human_reviews")
        )
    ]
    items = []
    if missing:
        items.append("missing documents: " + ", ".join(missing))
    if open_exceptions:
        items.append(f"{len(open_exceptions)} open policy exception(s)")
    if pending_reviews:
        items.append(f"{len(pending_reviews)} agent draft(s) awaiting human review")
    if not items:
        items.append(f"no recorded blocker — the {stage or 'current'} stage is simply unworked")
    return items, missing, open_exceptions, pending_reviews


def collect_stage_blockers(context):
    """Node `blockers`: what is actually holding the deal at its stage."""
    measure = context.get("measure") or {}
    inputs = context.get("inputs", context) or {}
    deal_code = measure.get("deal_id") or inputs.get("deal_id")
    items, missing, open_exceptions, pending_reviews = _blockers_for(
        deal_code, measure.get("current_stage")
    )
    return {
        "blocking_items": items,
        "open_exception_count": len(open_exceptions),
        "pending_review_count": len(pending_reviews),
        "missing_document_types": missing,
    }


workflow_engine.register_handler("collect_stage_blockers", collect_stage_blockers)


def apply_sla_escalation_action(context):
    """Node `apply`: the officer's reassign / return / acknowledge, applied."""
    inputs = context.get("inputs", context) or {}
    measure = context.get("measure") or {}
    deal_code = measure.get("deal_id") or inputs.get("deal_id")
    deal = _deal_or_404(deal_code)
    action = (inputs.get("escalation_action") or "acknowledge").lower()
    note = inputs.get("note") or ""
    actor = identity.require_actor(
        inputs.get("acting_user_email"), "deal.reassign", "act on the idle register"
    )

    reassigned_to_user_id = None
    returned_to_stage = None
    changes = {"last_activity_timestamp": _iso()}

    if action == "reassign":
        target_email = inputs.get("reassign_to_email")
        target = identity.known_actor(target_email)
        if target is None:
            raise HTTPException(status_code=400, detail=f"cannot reassign to unknown user '{target_email}'")
        reassigned_to_user_id = target["id"]
        changes["assigned_to_user_id"] = target["id"]
    elif action == "return":
        returned_to_stage = inputs.get("returned_to_stage")
        if returned_to_stage not in RETURNABLE_STAGES:
            raise HTTPException(
                status_code=400,
                detail=f"returned_to_stage must be one of {list(RETURNABLE_STAGES)}",
            )
        changes["current_stage"] = returned_to_stage
        changes["current_status"] = "returned"
        store.insert("deal_returns", {
            "deal_id": deal_code,
            "returned_from_stage": deal.get("current_stage"),
            "returned_to_stage": returned_to_stage,
            "returned_by_user_id": actor["id"],
            "reason": note or "returned from the idle register",
            "reassigned_to_user_id": None,
            "created_at": _iso(),
        })
    elif action != "acknowledge":
        raise HTTPException(status_code=400, detail="action must be reassign, return, or acknowledge")

    before = {
        "current_stage": deal.get("current_stage"),
        "assigned_to_user_id": deal.get("assigned_to_user_id"),
        "last_activity_timestamp": deal.get("last_activity_timestamp"),
    }
    updated = deals_repo.update_deal(deal_code, **changes)
    entry = audit("sla.escalation_applied", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": before,
        "after": {
            "action_taken": action,
            "current_stage": updated.get("current_stage"),
            "assigned_to_user_id": updated.get("assigned_to_user_id"),
            "note": note,
        },
    }, actor=actor["email"])
    return {
        "action_taken": action,
        "reassigned_to_user_id": reassigned_to_user_id,
        "returned_to_stage": returned_to_stage,
        "decided_by_user_id": actor["id"],
        "note": note,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("apply_sla_escalation_action", apply_sla_escalation_action)


# ---------------------------------------------------------------------------
# REST surface — the decision desk
# ---------------------------------------------------------------------------

class ApproveRequest(BaseModel):
    acting_user_email: str
    decision_notes: str | None = None


class DeclineRequest(BaseModel):
    acting_user_email: str
    reason_code: str
    reason_detail: str | None = None


class ReturnRequest(BaseModel):
    acting_user_email: str
    returned_to_stage: str
    reason: str
    reassign_to_email: str | None = None


class ReassignRequest(BaseModel):
    acting_user_email: str
    assign_to_email: str
    note: str | None = None


class EscalationRequest(BaseModel):
    acting_user_email: str
    action: str = "acknowledge"
    note: str | None = None
    reassign_to_email: str | None = None
    returned_to_stage: str | None = None


def _decision_payload(deal_code, row, tier, actor, replayed=False):
    deal = deals_repo.get_deal(deal_code)
    return {
        "deal_id": deal_code,
        "deal_code": deal_code,
        "borrower_name": deal.get("borrower_name"),
        "approval_id": row["id"],
        "decision": row["decision"],
        "is_approved": row["decision"] == "approved",
        "approval_authority_level": row["approval_authority_level"],
        "required_authority_level": tier["level"],
        "authority_level_verified": True,
        "exposure_amount": row.get("exposure_amount"),
        "decided_by": actor["email"],
        "decided_by_user_id": actor["id"],
        "decided_by_role": actor.get("role"),
        "decided_at": row["decided_at"],
        "decision_notes": row.get("decision_notes"),
        "idempotency_key": row["idempotency_key"],
        "replayed": replayed,
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
        "decline_reason_code": deal.get("decline_reason_code"),
        "decline_reason_detail": deal.get("decline_reason_detail"),
    }


@router.post("/api/deals/{deal_code}/approve")
def approve_deal(deal_code: str, req: ApproveRequest):
    """Approve a deal. Authority is a function of exposure, checked here."""
    deal = _deal_or_404(deal_code)
    actor, tier = _approver_or_403(req.acting_user_email, deal, "approve this deal")

    settled = _decided_approval(deal_code)
    if settled is not None and settled.get("decision") == "declined":
        raise HTTPException(
            status_code=409,
            detail=f"{deal_code} was already declined and cannot be approved",
        )

    row, replayed = _record_decision(deal, actor, "approved", req.decision_notes, tier)
    close_approved_deal({"inputs": {"deal_id": deal_code, "acting_user_email": actor["email"]}})
    audit("deal.approved", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "approval",
        "resource_id": row["id"],
        "before": {"current_status": deal.get("current_status")},
        "after": {
            "decision": "approved",
            "approval_authority_level": tier["level"],
            "decided_by": actor["email"],
            "idempotent_replay": replayed,
        },
    }, actor=actor["email"])
    return _decision_payload(deal_code, row, tier, actor, replayed)


@router.post("/api/deals/{deal_code}/decline")
def decline_deal(deal_code: str, req: DeclineRequest):
    """Decline with adverse action: a controlled reason code plus written detail."""
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.decline", "decline this deal")
    tier = _authority_or_403(actor, deal, "decline this deal")

    codes = active_reason_codes()
    if req.reason_code not in codes:
        raise HTTPException(
            status_code=400,
            detail=f"reason_code must be one of the controlled adverse-action codes: {codes}",
        )
    if not (req.reason_detail or "").strip():
        raise HTTPException(status_code=400, detail="an adverse action requires written reason_detail")

    settled = _decided_approval(deal_code)
    if settled is not None and settled.get("decision") == "approved":
        raise HTTPException(
            status_code=409,
            detail=f"{deal_code} was already approved and cannot be declined",
        )

    row, replayed = _record_decision(deal, actor, "declined", req.reason_detail, tier)
    deals_repo.update_deal(
        deal_code,
        current_stage="closing",
        current_status="declined",
        decline_reason_code=req.reason_code,
        decline_reason_detail=req.reason_detail,
        last_activity_timestamp=_iso(),
    )
    record_adverse_action_or_return({"inputs": {
        "deal_id": deal_code,
        "acting_user_email": actor["email"],
        "outcome": "declined",
        "adverse_action_reason_code": req.reason_code,
        "adverse_action_detail": req.reason_detail,
    }})
    audit("deal.declined", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "approval",
        "resource_id": row["id"],
        "before": {"current_status": deal.get("current_status")},
        "after": {
            "decision": "declined",
            "reason_code": req.reason_code,
            "reason_detail": req.reason_detail,
            "decided_by": actor["email"],
            "idempotent_replay": replayed,
        },
    }, actor=actor["email"])
    payload = _decision_payload(deal_code, row, tier, actor, replayed)
    payload["adverse_action_reason_code"] = req.reason_code
    payload["adverse_action_detail"] = req.reason_detail
    return payload


@router.post("/api/deals/{deal_code}/return")
def return_deal(deal_code: str, req: ReturnRequest):
    """Return a deal to an earlier stage with a written reason."""
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.return", "return this deal")
    if req.returned_to_stage not in RETURNABLE_STAGES:
        raise HTTPException(
            status_code=400,
            detail=f"returned_to_stage must be one of {list(RETURNABLE_STAGES)}",
        )
    if not (req.reason or "").strip():
        raise HTTPException(status_code=400, detail="a return requires a written reason")

    reassigned_to = None
    if req.reassign_to_email:
        target = identity.known_actor(req.reassign_to_email)
        if target is None:
            raise HTTPException(status_code=400, detail=f"cannot reassign to unknown user '{req.reassign_to_email}'")
        reassigned_to = target["id"]

    row = store.insert("deal_returns", {
        "deal_id": deal_code,
        "returned_from_stage": deal.get("current_stage"),
        "returned_to_stage": req.returned_to_stage,
        "returned_by_user_id": actor["id"],
        "reason": req.reason,
        "reassigned_to_user_id": reassigned_to,
        "created_at": _iso(),
    })
    changes = {
        "current_stage": req.returned_to_stage,
        "current_status": "returned",
        "last_activity_timestamp": _iso(),
    }
    if reassigned_to is not None:
        changes["assigned_to_user_id"] = reassigned_to
    updated = deals_repo.update_deal(deal_code, **changes)
    record_adverse_action_or_return({"inputs": {
        "deal_id": deal_code,
        "acting_user_email": actor["email"],
        "outcome": "returned",
        "returned_to_stage": req.returned_to_stage,
        "reassigned_to_user_id": reassigned_to,
    }})
    audit("deal.returned", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "deal_return",
        "resource_id": row["id"],
        "before": {"current_stage": deal.get("current_stage")},
        "after": {
            "current_stage": req.returned_to_stage,
            "reason": req.reason,
            "returned_by": actor["email"],
        },
    }, actor=actor["email"])
    return {
        "deal_id": deal_code,
        "outcome": "returned",
        "return_id": row["id"],
        "returned_from_stage": row["returned_from_stage"],
        "returned_to_stage": req.returned_to_stage,
        "reason": req.reason,
        "reassigned_to_user_id": reassigned_to,
        "returned_by": actor["email"],
        "current_stage": updated["current_stage"],
        "current_status": updated["current_status"],
    }


@router.get("/api/deals/{deal_code}/decisions")
def deal_decisions(deal_code: str, acting_user_email: str | None = None):
    """The decision record for a deal: tier, approvals/declines, returns."""
    deal = _deal_or_404(deal_code)
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action="read this deal's decisions")
        if not identity.can_view_deal(actor, deal):
            raise HTTPException(status_code=403, detail="this deal is outside your permission scope")
    tier = tier_for(deal.get("exposure_amount"))
    approvals = [
        {
            "approval_id": r["id"],
            "decision": r.get("decision"),
            "approval_authority_level": r.get("approval_authority_level"),
            "decided_by": r.get("decided_by_email") or _user_email(r.get("approved_by_user_id")),
            "decided_at": r.get("decided_at"),
            "decision_notes": r.get("decision_notes"),
            "idempotency_key": r.get("idempotency_key"),
        }
        for r in store.list("approvals") if r.get("deal_id") == deal_code
    ]
    returns = [
        {
            "return_id": r["id"],
            "returned_from_stage": r.get("returned_from_stage"),
            "returned_to_stage": r.get("returned_to_stage"),
            "reason": r.get("reason"),
            "returned_by": _user_email(r.get("returned_by_user_id")),
            "created_at": r.get("created_at"),
        }
        for r in store.list("deal_returns") if r.get("deal_id") == deal_code
    ]
    return {
        "deal_id": deal_code,
        "borrower_name": deal.get("borrower_name"),
        "exposure_amount": deal.get("exposure_amount"),
        "required_authority_level": tier["level"],
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
        "decline_reason_code": deal.get("decline_reason_code"),
        "decline_reason_detail": deal.get("decline_reason_detail"),
        "approvals": approvals,
        "returns": returns,
    }


@router.get("/api/approval-tiers")
def approval_tiers():
    """The published authority ladder — the UI shows it before a decision."""
    return {
        "ceiling": identity.MAX_APPROVAL_EXPOSURE,
        "tiers": [
            {
                "level": t["level"],
                "max_exposure": t["max_exposure"],
                "roles": list(t["roles"]),
            }
            for t in APPROVAL_TIERS
        ],
        "adverse_action_reasons": [
            {"reason_code": r["reason_code"], "reason_label": r["reason_label"]}
            for r in store.list("adverse_action_reasons") if r.get("is_active", True)
        ],
        "returnable_stages": list(RETURNABLE_STAGES),
        "pending_decisions": [
            {
                "deal_code": d.get("deal_code"),
                "borrower_name": d.get("borrower_name"),
                "exposure_amount": d.get("exposure_amount"),
                "required_authority_level": tier_for(d.get("exposure_amount"))["level"],
                "current_stage": d.get("current_stage"),
            }
            for d in deals_repo.all_current_deals()
            if d.get("current_status") not in FINAL_STATUSES
        ],
    }


# ---------------------------------------------------------------------------
# REST surface — the idle register
# ---------------------------------------------------------------------------

def _idle_row(deal, now):
    last_activity = deal.get("last_activity_timestamp") or deal.get("updated_at") or deal.get("created_at")
    idle = business_days_between(last_activity, now)
    owner_email = _user_email(deal.get("assigned_to_user_id"))
    blocking, _missing, open_exceptions, pending_reviews = _blockers_for(
        deal.get("deal_code"), deal.get("current_stage")
    )
    return {
        "deal_code": deal.get("deal_code"),
        "deal_id": deal.get("deal_code"),
        "borrower_name": deal.get("borrower_name"),
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
        "exposure_amount": float(deal.get("exposure_amount") or deal.get("requested_amount") or 0),
        "owner_email": owner_email,
        "owner": owner_email or "Unassigned",
        "escalation_owner": "officer@bank.test",
        "last_activity_timestamp": last_activity,
        "business_days_idle": idle,
        "sla_breached": idle > SLA_IDLE_BUSINESS_DAYS,
        "blocking_items": blocking,
        "open_exception_count": len(open_exceptions),
        "pending_review_count": len(pending_reviews),
    }


@router.get("/api/sla/idle")
def idle_register(acting_user_email: str | None = None):
    """Deals sitting past the five-business-day service line, worst first."""
    now = _now()
    deals = deals_repo.all_current_deals()
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action="read the idle register")
        deals = identity.visible_deals(actor, deals)
    active = [d for d in deals if d.get("current_status") not in FINAL_STATUSES]
    measured = [_idle_row(d, now) for d in active]
    breached = sorted(
        [m for m in measured if m["sla_breached"]],
        key=lambda m: m["business_days_idle"],
        reverse=True,
    )
    approaching = [
        m for m in measured
        if not m["sla_breached"] and m["business_days_idle"] >= APPROACHING_FROM
    ]
    by_stage, by_owner = {}, {}
    for m in breached:
        by_stage[m["current_stage"] or "unknown"] = by_stage.get(m["current_stage"] or "unknown", 0) + 1
        by_owner[m["owner"]] = by_owner.get(m["owner"], 0) + 1
    return {
        "as_of": _iso(now),
        "sla_threshold_business_days": SLA_IDLE_BUSINESS_DAYS,
        "calendar_basis": "business days — weekends and the seeded bank-holiday calendar excluded",
        "escalation_owner": "officer@bank.test",
        "counts": {
            "past_service_line": len(breached),
            "approaching": len(approaching),
            "active_deals": len(active),
        },
        "idle_exposure": round(sum(m["exposure_amount"] for m in breached), 2),
        "longest_idle": breached[0] if breached else None,
        "by_stage": by_stage,
        "by_owner": by_owner,
        "approaching_deals": approaching,
        "deals": breached,
    }


@router.post("/api/sla/{deal_code}/escalate")
def escalate_idle_deal(deal_code: str, req: EscalationRequest):
    """Drive the `sla-idle-escalation` workflow end to end for one deal.

    measure -> breached? -> blockers -> human escalation decision -> apply.
    The officer's choice is recorded through approval-flow (the human node's
    park point), then the run is ticked so the deterministic `apply` handler
    performs the reassign / return / acknowledge.
    """
    _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.reassign", "act on the idle register")
    inputs = {
        "deal_id": deal_code,
        "acting_user_email": actor["email"],
        "escalation_action": req.action,
        "note": req.note or "",
        "reassign_to_email": req.reassign_to_email,
        "returned_to_stage": req.returned_to_stage,
    }
    run_id = workflow_engine.start("sla-idle-escalation", inputs)
    state = workflow_engine.state(run_id)
    if state.get("status") == "parked" and state.get("approval_id") is not None:
        approval_flow.approve(
            state["approval_id"],
            actor["email"],
            reason=req.note or f"{req.action} from the idle register",
        )
        state = workflow_engine.tick(run_id)
    context = state.get("context") or {}
    measure = context.get("measure") or {}
    applied = context.get("apply") or {}
    return {
        "deal_id": deal_code,
        "run_id": run_id,
        "workflow": "sla-idle-escalation",
        "status": state.get("status"),
        "sla_breached": measure.get("sla_breached", False),
        "business_days_idle": measure.get("idle_business_days"),
        "blocking_items": (context.get("blockers") or {}).get("blocking_items", []),
        "action_taken": applied.get("action_taken", "none"),
        "reassigned_to_user_id": applied.get("reassigned_to_user_id"),
        "returned_to_stage": applied.get("returned_to_stage"),
        "note": applied.get("note", req.note or ""),
        "decided_by": actor["email"],
        "error": state.get("error"),
    }


@router.post("/api/deals/{deal_code}/reassign")
def reassign_deal(deal_code: str, req: ReassignRequest):
    """Hand an idle deal to another desk (the register's reassign action)."""
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.reassign", "reassign this deal")
    target = identity.known_actor(req.assign_to_email)
    if target is None:
        raise HTTPException(status_code=400, detail=f"cannot reassign to unknown user '{req.assign_to_email}'")
    updated = deals_repo.update_deal(
        deal_code,
        assigned_to_user_id=target["id"],
        last_activity_timestamp=_iso(),
    )
    store.insert("queue_assignments", {
        "deal_id": deal_code,
        "queue_name": "sla_escalation_queue",
        "assigned_to_user_id": target["id"],
        "claimed_by_user_id": None,
        "claimed_at": None,
        "status": "assigned",
        "created_at": _iso(),
        "updated_at": _iso(),
    })
    audit("deal.reassigned", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": {"assigned_to_user_id": deal.get("assigned_to_user_id")},
        "after": {"assigned_to_user_id": target["id"], "note": req.note or ""},
    }, actor=actor["email"])
    return {
        "deal_id": deal_code,
        "assigned_to": target["email"],
        "assigned_to_user_id": target["id"],
        "reassigned_by": actor["email"],
        "note": req.note or "",
        "last_activity_timestamp": updated["last_activity_timestamp"],
    }
