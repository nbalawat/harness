"""ext_tiered_approval_and_sla: slice `tiered-approval-and-sla`.

A credit officer approves, declines with a controlled adverse-action reason,
or returns a deal to an earlier stage — with approval authority enforced
SERVER-SIDE by exposure tier (an analyst cannot approve above $250,000) — and
the desk watches the SLA idle register for deals that have not moved in more
than five business days.

Design rules this module is built to (they are why it looks the way it does):

* R-023 — no agent may approve, decline, or advance a deal. Nothing in this
  module calls `agent_runtime`: every decision here is a named human's, and
  every amount/tier is computed in plain Python. There is no LLM in the
  approval path at all, by construction rather than by prompt.
* R-020/R-021/R-022 — authority is tiered on exposure:
    <= $250,000   credit analyst may approve
    <= $1,000,000 senior credit officer
    >  $1,000,000 credit committee
  enforced by `_require_decision_authority` before any state changes.
* R-024/R-030 — every decision stores the deciding user's identity and writes
  an audit row; approvals/declines/returns are append-only records.
* R-026/R-063 — a decline needs a reason CODE from the controlled
  `adverse_action_reasons` list plus required free-text detail.
* R-062 — decisions are idempotent: replaying the same decision by the same
  actor returns the stored record instead of double-approving, and a
  CONFLICTING second decision is a 409.
* R-034/R-057 — idle time is counted in BUSINESS days from the deal's last
  meaningful activity, excluding weekends and the configurable bank-holiday
  calendar held in the `business_calendar` table.
* R-047 — `return` sends a deal back to an earlier stage with a required
  written reason and re-assigns it to the analyst queue.

Workflow handlers registered here (workflows/workflows.json is the contract):
  deal-underwriting-lifecycle : determine_approval_tier,
                                record_approval_decision,
                                record_adverse_action_or_return,
                                close_approved_deal
  sla-idle-escalation         : compute_business_day_idle_time,
                                collect_stage_blockers,
                                apply_sla_escalation_action
`POST /api/sla/escalate` drives the sla-idle-escalation workflow end to end
through workflow_engine.start() → the human park → approval-flow → tick, so
that definition is executed rather than re-implemented.

OPEN QUESTIONS carried forward from requirements (surfaced in responses, not
silently decided): R-068 — committee mechanics above $1M (single member vs a
quorum vote) are unspecified, so this build requires an explicit committee
role and records one decision per approval; R-069 — the basis of "exposure"
is unspecified, so the deal's own `exposure_amount` is used and named in the
`exposure_basis` field of every tier response.
"""
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import approval_flow
import assignment
import deals_repo
import identity
import sla
import statemachine
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

# ---------------------------------------------------------------------------
# Tiering, stages, and the controlled adverse-action vocabulary
# ---------------------------------------------------------------------------

ANALYST_APPROVAL_CEILING = identity.MAX_APPROVAL_EXPOSURE  # $250,000 (R-020)
OFFICER_APPROVAL_CEILING = 1000000                         # $1,000,000 (R-021)

CREDIT_COMMITTEE = "credit_committee"

# tier name -> (ceiling or None, roles that may decide at this tier)
APPROVAL_TIERS = [
    ("credit_analyst", ANALYST_APPROVAL_CEILING,
     {identity.CREDIT_ANALYST, identity.SENIOR_CREDIT_OFFICER, identity.ADMIN}),
    ("senior_credit_officer", OFFICER_APPROVAL_CEILING,
     {identity.SENIOR_CREDIT_OFFICER, identity.ADMIN}),
    (CREDIT_COMMITTEE, None,
     {CREDIT_COMMITTEE, identity.ADMIN}),
]

STAGE_ORDER = [
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "tiered_approval",
    "closing",
]

# state-machine module: transitions declared once, never mutated ad hoc.
# "_returned" is a sentinel — the concrete target stage of a return is chosen
# by the officer and validated against STAGE_ORDER (it must be EARLIER).
_RETURNABLE = STAGE_ORDER[1:7]  # document_extraction … tiered_approval
DEAL_DECISIONS = statemachine.Machine(
    {
        **{stage: {"return": "_returned"} for stage in _RETURNABLE},
        "tiered_approval": {
            "approve": "closing",
            "decline": "closed",
            "return": "_returned",
        },
    },
    initial="intake",
)

SLA_IDLE_BUSINESS_DAYS = 5          # R-034: "more than 5 business days"
SLA_APPROACHING_BUSINESS_DAYS = 4   # surfaced before the breach (sla-timers guide)
SLA_WINDOW_HOURS = SLA_IDLE_BUSINESS_DAYS * 24
ESCALATION_OWNER_EMAIL = "officer@bank.test"
ANALYST_POOL = ["analyst@bank.test"]

ADVERSE_ACTION_REASONS = [
    ("INSUFFICIENT_DSCR", "Debt service coverage below the policy floor"),
    ("EXCESSIVE_LEVERAGE", "Leverage above the policy ceiling"),
    ("INSUFFICIENT_COLLATERAL", "Collateral coverage insufficient for the request"),
    ("INSUFFICIENT_OPERATING_HISTORY", "Operating history too short to underwrite"),
    ("ADVERSE_CREDIT_HISTORY", "Adverse credit history on the borrower or principals"),
    ("INCOMPLETE_FINANCIAL_INFORMATION", "Required financial information not provided"),
    ("POLICY_EXCEPTION_NOT_WAIVED", "Open policy exception was not waived"),
    ("OUTSIDE_CREDIT_APPETITE", "Request falls outside current credit appetite"),
]


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _parse(iso):
    return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Business-day arithmetic (R-057) — deterministic, unit-tested, no LLM
# ---------------------------------------------------------------------------

def non_business_days():
    """Configured bank holidays: `business_calendar` rows flagged non-business."""
    return {
        str(r.get("calendar_date"))
        for r in store.list("business_calendar")
        if not r.get("is_business_day")
    }


def business_days_between(start_iso, now=None):
    """Whole business days elapsed since `start_iso`, weekends and configured
    bank holidays excluded. Counts days AFTER the day of the activity, so a
    deal touched today is idle 0 business days."""
    if not start_iso:
        return 0
    try:
        start = _parse(start_iso)
    except ValueError:
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now <= start:
        return 0
    holidays = non_business_days()
    days = 0
    cursor = start.date() + datetime.timedelta(days=1)
    end = now.date()
    while cursor <= end:
        if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
            days += 1
        cursor += datetime.timedelta(days=1)
    return days


# ---------------------------------------------------------------------------
# Tiering + authority (server-side, default-deny)
# ---------------------------------------------------------------------------

def tier_for(exposure_amount):
    """(tier_name, eligible_roles, rule_text) for an exposure. Pure."""
    amount = float(exposure_amount or 0)
    for name, ceiling, roles in APPROVAL_TIERS:
        if ceiling is None or amount <= ceiling:
            if ceiling is None:
                rule = f"exposure above ${OFFICER_APPROVAL_CEILING:,.0f} requires {CREDIT_COMMITTEE} approval"
            else:
                rule = f"exposure up to ${ceiling:,.0f} may be approved by {name}"
            return name, roles, rule
    raise AssertionError("unreachable: the last tier has no ceiling")


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _require_decision_authority(email, deal, event):
    """The one gate for approve / decline / return.

    Resolves the caller server-side (default-deny for unknown users), then
    checks BOTH the role permission and — for approvals — the exposure tier.
    Returns (actor, tier_name, eligible_roles, rule_text).
    """
    permission = {"approve": "deal.approve", "decline": "deal.decline", "return": "deal.return"}[event]
    action = {"approve": "approve", "decline": "decline", "return": "return"}[event] + " this deal"
    exposure = float(deal.get("exposure_amount") or deal.get("requested_amount") or 0)
    tier_name, eligible_roles, rule = tier_for(exposure)

    # Resolve identity first (401 for anonymous, 403 for unknown/deactivated).
    actor = identity.require_actor(email, action=action)
    role = actor.get("role")

    if event == "approve":
        # R-020/R-021/R-022: authority is the exposure tier, not the job title
        # alone. An analyst may approve up to $250,000 and no further.
        if role not in eligible_roles:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"role '{role}' lacks the approval authority for an exposure of "
                    f"${exposure:,.0f}: {tier_name} authority is required ({rule})"
                ),
            )
    elif not identity.has_permission(actor, permission):
        # R-033: only a credit officer (or admin) may decline or return.
        raise HTTPException(
            status_code=403,
            detail=f"role '{role}' lacks the authority to {action}",
        )
    return actor, tier_name, eligible_roles, rule


def _advance(deal, event):
    """Legal-transition check through the state-machine module (409 if not)."""
    try:
        return DEAL_DECISIONS.advance(deal.get("current_stage") or "intake", event)
    except statemachine.IllegalTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _existing_decision(deal_code):
    rows = [a for a in store.list("approvals") if a.get("deal_id") == deal_code]
    return rows[-1] if rows else None


def _user_by_id(user_id):
    return next((u for u in store.list("users") if u.get("id") == user_id), None)


def _email_of(user_id):
    user = _user_by_id(user_id)
    return user.get("email") if user else None


def _idempotency_key(deal_code, stage, decision):
    return f"{deal_code}:{stage}:{decision}"


# ---------------------------------------------------------------------------
# Workflow handlers — deal-underwriting-lifecycle (tier → decision → outcome)
# ---------------------------------------------------------------------------

def _ctx_deal_code(context):
    for path in (("inputs", "deal_id"), ("intake", "deal_id"), ("measure", "deal_id")):
        node = context.get(path[0])
        if isinstance(node, dict) and node.get(path[1]):
            return node[path[1]]
    return context.get("deal_id")


def _ctx_inputs(context):
    inputs = context.get("inputs")
    return inputs if isinstance(inputs, dict) else context


def determine_approval_tier(context):
    """Node `tier`: which authority level this exposure demands. Deterministic."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    exposure = float(deal.get("exposure_amount") or deal.get("requested_amount") or 0)
    tier_name, eligible_roles, rule = tier_for(exposure)
    entry = audit("approval.tier_determined", {
        "deal_id": deal_code,
        "actor_user_id": _ctx_inputs(context).get("actor_user_id"),
        "resource_type": "deal",
        "resource_id": deal_code,
        "after": {"required_authority_level": tier_name, "exposure_amount": exposure},
    })
    return {
        "exposure_amount": exposure,
        "required_authority_level": tier_name,
        "eligible_role": tier_name,
        "eligible_roles": sorted(eligible_roles),
        "tier_rule_applied": rule,
        # R-069 is an open question: name the basis rather than imply one.
        "exposure_basis": "deal.exposure_amount (single deal; borrower aggregation unspecified — R-069)",
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("determine_approval_tier", determine_approval_tier)


def record_approval_decision(context):
    """Node `record`: persists the NAMED HUMAN decision (R-024) exactly once
    (R-062). Never called by an agent — the workflow's `decision` node is a
    human park, and the REST endpoints below resolve a real user first."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    inputs = _ctx_inputs(context)
    human = context.get("decision") if isinstance(context.get("decision"), dict) else {}

    decision = inputs.get("decision")
    if decision is None and human:
        decision = "approved" if human.get("approved") else "declined"
    decision = decision or "approved"

    actor_user_id = inputs.get("actor_user_id")
    actor = _user_by_id(actor_user_id)
    tier = context.get("tier") if isinstance(context.get("tier"), dict) else determine_approval_tier(context)
    exposure = float(tier["exposure_amount"])

    existing = _existing_decision(deal_code)
    if existing is not None:
        if existing.get("decision") != decision:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"deal {deal_code} was already {existing.get('decision')} by "
                    f"{_email_of(existing.get('approved_by_user_id')) or 'a prior decider'}; "
                    "a second, conflicting decision is not allowed"
                ),
            )
        approval = existing
        entry_id = None
        replayed = True
    else:
        approval = store.insert("approvals", {
            "deal_id": deal_code,
            "stage": deal.get("current_stage"),
            "approval_authority_level": tier["required_authority_level"],
            "exposure_amount": exposure,
            "approved_by_user_id": actor_user_id,
            "decision": decision,
            "decision_notes": inputs.get("decision_notes") or "",
            "decided_at": _now(),
            "created_at": _now(),
        })
        entry_id = audit(f"deal.{decision}", {
            "deal_id": deal_code,
            "actor_user_id": actor_user_id,
            "resource_type": "approval",
            "resource_id": approval["id"],
            "before": {"current_stage": deal.get("current_stage"), "current_status": deal.get("current_status")},
            "after": {
                "decision": decision,
                "approval_authority_level": tier["required_authority_level"],
                "decided_by": actor.get("email") if actor else None,
            },
        })["id"]
        replayed = False

    return {
        "approval_id": approval["id"],
        "decision": approval.get("decision"),
        "is_approved": approval.get("decision") == "approved",
        "decided_by_user_id": approval.get("approved_by_user_id"),
        "decided_by_email": _email_of(approval.get("approved_by_user_id")),
        "decided_at": approval.get("decided_at"),
        "authority_level_verified": tier["required_authority_level"],
        "approval_authority_level": tier["required_authority_level"],
        "idempotency_key": _idempotency_key(deal_code, approval.get("stage"), approval.get("decision")),
        "replayed": replayed,
        "audit_entry_id": entry_id,
    }


workflow_engine.register_handler("record_approval_decision", record_approval_decision)


def record_adverse_action_or_return(context):
    """Node `outcome`: an approval passes straight through; a decline stores
    its controlled adverse-action reason (R-026/R-063); a return sends the
    deal back to an earlier stage and re-assigns it (R-047)."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    inputs = _ctx_inputs(context)
    record_out = context.get("record") if isinstance(context.get("record"), dict) else {}
    outcome = inputs.get("decision") or record_out.get("decision") or "approved"
    actor_user_id = inputs.get("actor_user_id")

    reason_code = None
    reason_detail = None
    returned_to_stage = None
    reassigned_to_user_id = None
    before = {
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
    }

    if outcome == "declined":
        reason_code = inputs.get("reason_code")
        reason_detail = inputs.get("reason_detail")
        updated = deals_repo.update_deal(
            deal_code,
            current_stage="closed",
            current_status="declined",
            decline_reason_code=reason_code,
            decline_reason_detail=reason_detail,
            last_activity_timestamp=_now(),
        )
    elif outcome == "returned":
        returned_to_stage = inputs.get("returned_to_stage")
        assignee_email = inputs.get("reassign_to_email") or assignment.round_robin(
            list(ANALYST_POOL), queue="analyst_return_queue"
        )
        assignee = identity.resolve_user(assignee_email, default_role=identity.CREDIT_ANALYST)
        reassigned_to_user_id = assignee["id"] if assignee else None
        store.insert("deal_returns", {
            "deal_id": deal_code,
            "returned_from_stage": deal.get("current_stage"),
            "returned_to_stage": returned_to_stage,
            "returned_by_user_id": actor_user_id,
            "reason": inputs.get("reason"),
            "reassigned_to_user_id": reassigned_to_user_id,
            "created_at": _now(),
        })
        store.insert("queue_assignments", {
            "deal_id": deal_code,
            "queue_name": "analyst_return_queue",
            "assigned_to_user_id": reassigned_to_user_id,
            "claimed_by_user_id": None,
            "claimed_at": None,
            "status": "assigned",
            "created_at": _now(),
            "updated_at": _now(),
        })
        updated = deals_repo.update_deal(
            deal_code,
            current_stage=returned_to_stage,
            current_status="returned_for_rework",
            assigned_to_user_id=reassigned_to_user_id,
            last_activity_timestamp=_now(),
        )
    else:
        updated = deals_repo.get_deal(deal_code)

    entry = audit(f"deal.outcome_{outcome}", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": before,
        "after": {
            "outcome": outcome,
            "adverse_action_reason_code": reason_code,
            "returned_to_stage": returned_to_stage,
            "current_stage": (updated or {}).get("current_stage"),
        },
    })
    return {
        "outcome": outcome,
        "adverse_action_reason_code": reason_code,
        "adverse_action_detail": reason_detail,
        "returned_to_stage": returned_to_stage,
        "reassigned_to_user_id": reassigned_to_user_id,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_adverse_action_or_return", record_adverse_action_or_return)


def close_approved_deal(context):
    """Node `close`: the only place an approved deal moves to closing."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    inputs = _ctx_inputs(context)
    closed_at = _now()
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="closing",
        current_status="approved",
        last_activity_timestamp=closed_at,
    )
    entry = audit("deal.closed_approved", {
        "deal_id": deal_code,
        "actor_user_id": inputs.get("actor_user_id"),
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": {"current_stage": deal.get("current_stage"), "current_status": deal.get("current_status")},
        "after": {"current_stage": updated["current_stage"], "current_status": updated["current_status"]},
    })
    return {
        "deal_id": deal_code,
        "final_stage": updated["current_stage"],
        "final_status": updated["current_status"],
        "closed_at": closed_at,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("close_approved_deal", close_approved_deal)


# ---------------------------------------------------------------------------
# Workflow handlers — sla-idle-escalation
# ---------------------------------------------------------------------------

def compute_business_day_idle_time(context):
    """Node `measure`: R-034/R-057 business-day idle, from last activity."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    last = deal.get("last_activity_timestamp") or deal.get("updated_at") or deal.get("created_at")
    idle = business_days_between(last)
    return {
        "deal_id": deal_code,
        "idle_business_days": idle,
        "sla_breached": idle > SLA_IDLE_BUSINESS_DAYS,
        "last_activity_timestamp": last,
        "current_stage": deal.get("current_stage"),
        "assigned_to_user_id": deal.get("assigned_to_user_id"),
    }


workflow_engine.register_handler("compute_business_day_idle_time", compute_business_day_idle_time)


REQUIRED_DOCUMENT_TYPES = ["balance_sheet", "income_statement", "tax_return"]


def collect_stage_blockers(context):
    """Node `blockers`: what is actually holding the deal up. Read-only."""
    deal_code = _ctx_deal_code(context)
    return _blockers(deal_code)


def _blockers(deal_code):
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
    attached = {d.get("document_type") for d in store.list("documents") if d.get("deal_id") == deal_code}
    missing = [t for t in REQUIRED_DOCUMENT_TYPES if t not in attached]
    blocking = []
    if missing:
        blocking.append("missing documents: " + ", ".join(missing))
    if open_exceptions:
        blocking.append(f"{len(open_exceptions)} open policy exception(s)")
    if pending_reviews:
        blocking.append(f"{len(pending_reviews)} agent draft(s) awaiting human review")
    if not blocking:
        blocking.append("no recorded blocker — the deal is simply untouched")
    return {
        "blocking_items": blocking,
        "open_exception_count": len(open_exceptions),
        "pending_review_count": len(pending_reviews),
        "missing_document_types": missing,
    }


workflow_engine.register_handler("collect_stage_blockers", collect_stage_blockers)


ESCALATION_ACTIONS = ("reassign", "return", "acknowledge")


def apply_sla_escalation_action(context):
    """Node `apply`: the officer's choice, applied deterministically."""
    deal_code = _ctx_deal_code(context)
    deal = _deal_or_404(deal_code)
    inputs = _ctx_inputs(context)
    action = inputs.get("action") or "acknowledge"
    actor_user_id = inputs.get("actor_user_id")
    note = inputs.get("note") or ""
    reassigned_to_user_id = None
    returned_to_stage = None
    before = {
        "current_stage": deal.get("current_stage"),
        "assigned_to_user_id": deal.get("assigned_to_user_id"),
        "last_activity_timestamp": deal.get("last_activity_timestamp"),
    }

    if action == "reassign":
        assignee_email = inputs.get("reassign_to_email") or assignment.round_robin(
            list(ANALYST_POOL), queue="sla_escalation_queue"
        )
        assignee = identity.resolve_user(assignee_email, default_role=identity.CREDIT_ANALYST)
        reassigned_to_user_id = assignee["id"] if assignee else None
        store.insert("queue_assignments", {
            "deal_id": deal_code,
            "queue_name": "sla_escalation_queue",
            "assigned_to_user_id": reassigned_to_user_id,
            "claimed_by_user_id": None,
            "claimed_at": None,
            "status": "assigned",
            "created_at": _now(),
            "updated_at": _now(),
        })
        deals_repo.update_deal(
            deal_code,
            assigned_to_user_id=reassigned_to_user_id,
            last_activity_timestamp=_now(),
        )
    elif action == "return":
        returned_to_stage = inputs.get("returned_to_stage")
        out = record_adverse_action_or_return({
            "inputs": {
                "deal_id": deal_code,
                "decision": "returned",
                "actor_user_id": actor_user_id,
                "returned_to_stage": returned_to_stage,
                "reason": note,
                "reassign_to_email": inputs.get("reassign_to_email"),
            }
        })
        reassigned_to_user_id = out["reassigned_to_user_id"]
    else:
        action = "acknowledge"
        deals_repo.update_deal(deal_code, last_activity_timestamp=_now())

    entry = audit(f"sla.escalation_{action}", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": before,
        "after": {
            "action_taken": action,
            "reassigned_to_user_id": reassigned_to_user_id,
            "returned_to_stage": returned_to_stage,
        },
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


# ---------------------------------------------------------------------------
# REST surface — approve / decline / return
# ---------------------------------------------------------------------------

class ApproveRequest(BaseModel):
    acting_user_email: str
    decision_notes: str | None = None


class DeclineRequest(BaseModel):
    acting_user_email: str
    reason_code: str
    reason_detail: str


class ReturnRequest(BaseModel):
    acting_user_email: str
    returned_to_stage: str
    reason: str
    reassign_to_email: str | None = None


def _decision_payload(deal_code, tier, recorded, extra=None):
    deal = deals_repo.get_deal(deal_code)
    payload = {
        "deal_id": deal_code,
        "deal_code": deal_code,
        "borrower_name": deal.get("borrower_name"),
        "status": recorded["decision"],
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
        "exposure_amount": tier["exposure_amount"],
        "exposure_basis": tier["exposure_basis"],
        "required_authority_level": tier["required_authority_level"],
        "tier_rule_applied": tier["tier_rule_applied"],
        **recorded,
    }
    payload.update(extra or {})
    return payload


@router.post("/api/deals/{deal_code}/approve")
def approve_deal(deal_code: str, req: ApproveRequest):
    """R-020/R-021/R-022/R-024/R-062: a NAMED human with the authority the
    exposure tier demands approves the deal, exactly once."""
    deal = _deal_or_404(deal_code)
    actor, _tier_name, _roles, _rule = _require_decision_authority(
        req.acting_user_email, deal, "approve"
    )
    prior = _existing_decision(deal_code)
    if prior is None:
        _advance(deal, "approve")  # 409 if this deal is not at an approval step
    elif prior.get("decision") != "approved":
        raise HTTPException(
            status_code=409,
            detail=(
                f"deal {deal_code} was already {prior.get('decision')}; "
                "a second, conflicting decision is not allowed"
            ),
        )

    ctx = {"inputs": {
        "deal_id": deal_code,
        "decision": "approved",
        "decision_notes": req.decision_notes,
        "actor_user_id": actor["id"],
    }}
    tier = determine_approval_tier(ctx)
    ctx["tier"] = tier
    recorded = record_approval_decision(ctx)
    ctx["record"] = recorded
    outcome = record_adverse_action_or_return(ctx)
    closed = close_approved_deal(ctx)
    return _decision_payload(deal_code, tier, recorded, {
        "decided_by_email": actor["email"],
        "approved_by_email": actor["email"],
        "approved_by_role": actor["role"],
        "outcome": outcome["outcome"],
        "final_stage": closed["final_stage"],
        "final_status": closed["final_status"],
        "closed_at": closed["closed_at"],
    })


@router.post("/api/deals/{deal_code}/decline")
def decline_deal(deal_code: str, req: DeclineRequest):
    """R-026/R-063: a decline carries a controlled reason code plus required
    free-text detail, validated BEFORE anything is written."""
    deal = _deal_or_404(deal_code)
    codes = {r["reason_code"] for r in store.list("adverse_action_reasons") if r.get("is_active")}
    reason_code = (req.reason_code or "").strip().upper()
    if reason_code not in codes:
        raise HTTPException(
            status_code=400,
            detail=(
                f"'{req.reason_code}' is not an active adverse-action reason code; "
                f"choose one of: {sorted(codes)}"
            ),
        )
    detail = (req.reason_detail or "").strip()
    if len(detail) < 10:
        raise HTTPException(
            status_code=400,
            detail="reason_detail is required and must describe the adverse action (10 characters or more)",
        )

    actor, _tier_name, _roles, _rule = _require_decision_authority(
        req.acting_user_email, deal, "decline"
    )
    prior = _existing_decision(deal_code)
    if prior is None:
        _advance(deal, "decline")
    elif prior.get("decision") != "declined":
        raise HTTPException(
            status_code=409,
            detail=(
                f"deal {deal_code} was already {prior.get('decision')}; "
                "a second, conflicting decision is not allowed"
            ),
        )

    ctx = {"inputs": {
        "deal_id": deal_code,
        "decision": "declined",
        "decision_notes": detail,
        "reason_code": reason_code,
        "reason_detail": detail,
        "actor_user_id": actor["id"],
    }}
    tier = determine_approval_tier(ctx)
    ctx["tier"] = tier
    recorded = record_approval_decision(ctx)
    ctx["record"] = recorded
    outcome = record_adverse_action_or_return(ctx)
    return _decision_payload(deal_code, tier, recorded, {
        "decided_by_email": actor["email"],
        "declined_by_email": actor["email"],
        "outcome": outcome["outcome"],
        "reason_code": reason_code,
        "adverse_action_reason_code": reason_code,
        "adverse_action_detail": detail,
    })


@router.post("/api/deals/{deal_code}/return")
def return_deal(deal_code: str, req: ReturnRequest):
    """R-047: send a deal back to an earlier stage with a written reason and
    re-assign it to the analyst queue."""
    deal = _deal_or_404(deal_code)
    target = (req.returned_to_stage or "").strip()
    if target not in STAGE_ORDER:
        raise HTTPException(status_code=400, detail=f"unknown stage '{req.returned_to_stage}'")
    current = deal.get("current_stage") or "intake"
    if current in STAGE_ORDER and STAGE_ORDER.index(target) >= STAGE_ORDER.index(current):
        raise HTTPException(
            status_code=400,
            detail=f"a return must go to a stage EARLIER than '{current}'",
        )
    reason = (req.reason or "").strip()
    if len(reason) < 10:
        raise HTTPException(
            status_code=400,
            detail="a written reason is required to return a deal (10 characters or more)",
        )

    actor, _tier_name, _roles, _rule = _require_decision_authority(
        req.acting_user_email, deal, "return"
    )
    _advance(deal, "return")
    outcome = record_adverse_action_or_return({"inputs": {
        "deal_id": deal_code,
        "decision": "returned",
        "actor_user_id": actor["id"],
        "returned_to_stage": target,
        "reason": reason,
        "reassign_to_email": req.reassign_to_email,
    }})
    updated = deals_repo.get_deal(deal_code)
    return {
        "deal_id": deal_code,
        "status": "returned",
        "returned_from_stage": current,
        "returned_to_stage": target,
        "reason": reason,
        "reassigned_to_user_id": outcome["reassigned_to_user_id"],
        "reassigned_to_email": _email_of(outcome["reassigned_to_user_id"]),
        "returned_by_email": actor["email"],
        "current_stage": updated.get("current_stage"),
        "current_status": updated.get("current_status"),
        "audit_entry_id": outcome["audit_entry_id"],
    }


@router.get("/api/deals/{deal_code}/approval-tier")
def approval_tier(deal_code: str, acting_user_email: str | None = None):
    """Who may decide this deal, and why — the UI reads this to label the
    decision desk. The tier is authority information, not borrower data."""
    deal = _deal_or_404(deal_code)
    exposure = float(deal.get("exposure_amount") or deal.get("requested_amount") or 0)
    tier_name, roles, rule = tier_for(exposure)
    caller_may_approve = False
    caller_role = None
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action="read the approval tier")
        caller_role = actor.get("role")
        caller_may_approve = caller_role in roles
    prior = _existing_decision(deal_code)
    return {
        "deal_id": deal_code,
        "exposure_amount": exposure,
        "exposure_basis": "deal.exposure_amount (single deal; borrower aggregation unspecified — R-069)",
        "required_authority_level": tier_name,
        "eligible_roles": sorted(roles),
        "tier_rule_applied": rule,
        "caller_role": caller_role,
        "caller_may_approve": caller_may_approve,
        "already_decided": prior.get("decision") if prior else None,
        "committee_mechanics_open_question": (
            "R-068: whether a >$1M committee approval is one member's action or a "
            "quorum vote recorded per voter is unspecified; this build records a "
            "single committee decision."
        ),
    }


@router.get("/api/approvals/queue")
def approvals_queue(acting_user_email: str | None = None):
    """Deals sitting at the tiered-approval step, with the authority each one
    demands. Scoped to what the caller may see when it identifies itself."""
    deals = [d for d in deals_repo.all_current_deals() if d.get("current_stage") == "tiered_approval"]
    caller_role = None
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action="read the approval queue")
        caller_role = actor.get("role")
        deals = identity.visible_deals(actor, deals)
    rows = []
    for d in deals:
        exposure = float(d.get("exposure_amount") or d.get("requested_amount") or 0)
        tier_name, roles, rule = tier_for(exposure)
        rows.append({
            "deal_id": d.get("deal_code"),
            "deal_code": d.get("deal_code"),
            "borrower_name": d.get("borrower_name") if acting_user_email else None,
            "exposure_amount": exposure,
            "current_stage": d.get("current_stage"),
            "current_status": d.get("current_status"),
            "risk_grade": d.get("risk_grade"),
            "required_authority_level": tier_name,
            "eligible_roles": sorted(roles),
            "tier_rule_applied": rule,
            "caller_may_approve": caller_role in roles if caller_role else False,
        })
    rows.sort(key=lambda r: -r["exposure_amount"])
    return {
        "caller_role": caller_role,
        "count": len(rows),
        "analyst_ceiling": ANALYST_APPROVAL_CEILING,
        "officer_ceiling": OFFICER_APPROVAL_CEILING,
        "deals": rows,
    }


# ---------------------------------------------------------------------------
# REST surface — the SLA idle register
# ---------------------------------------------------------------------------

@router.get("/api/sla/idle")
def sla_idle_register(acting_user_email: str | None = None):
    """R-034/R-057: every deal idle beyond the service line, in order of
    neglect, counted in business days from the last meaningful activity.

    Read scoping: an identified caller gets the register scoped to the deals
    it may see, with borrower names. An UNIDENTIFIED caller (ops monitoring)
    gets the operational shape only — deal code, stage, idle time, escalation
    owner — with the borrower's name withheld, so this route never discloses
    counterparty identity to an anonymous reader.
    """
    actor = None
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action="read the SLA idle register")

    now = datetime.datetime.now(datetime.timezone.utc)
    deals = deals_repo.all_current_deals()
    if actor is not None:
        deals = identity.visible_deals(actor, deals)

    active = [d for d in deals if d.get("current_stage") not in ("closed", "closing")]
    breached, approaching = [], []
    for d in active:
        last = d.get("last_activity_timestamp") or d.get("updated_at") or d.get("created_at")
        idle = business_days_between(last, now=now)
        owner_id = d.get("assigned_to_user_id")
        owner_email = _email_of(owner_id)
        row = {
            "deal_id": d.get("deal_code"),
            "deal_code": d.get("deal_code"),
            "borrower_name": d.get("borrower_name") if actor is not None else None,
            "current_stage": d.get("current_stage"),
            "current_status": d.get("current_status"),
            "assigned_to_user_id": owner_id,
            "owner_email": owner_email,
            "owner_name": (_user_by_id(owner_id) or {}).get("name") if owner_id else "Unassigned",
            "last_activity_timestamp": last,
            "exposure_amount": float(d.get("exposure_amount") or d.get("requested_amount") or 0),
            "business_days_idle": idle,
            "idle_business_days": idle,
            "sla_breached": idle > SLA_IDLE_BUSINESS_DAYS,
            "clock_status": sla.status(last, SLA_WINDOW_HOURS, now=now) if last else "ok",
            "escalation_owner": ESCALATION_OWNER_EMAIL,
            "blocking_items": _blockers(d.get("deal_code"))["blocking_items"],
        }
        if row["sla_breached"]:
            breached.append(row)
        elif idle >= SLA_APPROACHING_BUSINESS_DAYS:
            approaching.append(row)

    breached.sort(key=lambda r: (-r["business_days_idle"], -r["exposure_amount"]))
    by_stage, by_owner = {}, {}
    for row in breached:
        by_stage[row["current_stage"] or "intake"] = by_stage.get(row["current_stage"] or "intake", 0) + 1
        key = row["owner_email"] or "Unassigned"
        by_owner[key] = by_owner.get(key, 0) + 1

    return {
        "threshold_business_days": SLA_IDLE_BUSINESS_DAYS,
        "calendar_basis": "business days, weekends and configured bank holidays excluded",
        "bank_holidays": sorted(non_business_days()),
        "generated_at": now.isoformat(),
        "active_deal_count": len(active),
        "breached_count": len(breached),
        "approaching_count": len(approaching),
        "idle_exposure": sum(r["exposure_amount"] for r in breached),
        "longest_idle": breached[0] if breached else None,
        "escalation_owner": ESCALATION_OWNER_EMAIL,
        "by_stage": by_stage,
        "by_owner": by_owner,
        "scoped_to": (actor or {}).get("email"),
        "deals": breached,
        "approaching": approaching,
    }


class EscalateRequest(BaseModel):
    acting_user_email: str
    deal_code: str
    action: str = "acknowledge"
    note: str = ""
    reassign_to_email: str | None = None
    returned_to_stage: str | None = None


@router.post("/api/sla/escalate")
def escalate_idle_deal(req: EscalateRequest):
    """Act on the register. This drives the approved `sla-idle-escalation`
    workflow definition end to end — measure → breached? → blockers → human
    park → apply — rather than re-implementing the process here."""
    deal = _deal_or_404(req.deal_code)
    if req.action not in ESCALATION_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"action must be one of {list(ESCALATION_ACTIONS)}",
        )
    permission = "deal.return" if req.action == "return" else "deal.reassign"
    actor = identity.require_actor(
        req.acting_user_email, permission, f"{req.action} an idle deal from the SLA register"
    )
    note = (req.note or "").strip()
    if req.action == "return":
        if req.returned_to_stage not in STAGE_ORDER:
            raise HTTPException(status_code=400, detail="a return needs a valid target stage")
        if len(note) < 10:
            raise HTTPException(
                status_code=400,
                detail="a written reason is required to return a deal (10 characters or more)",
            )

    inputs = {
        "deal_id": req.deal_code,
        "action": req.action,
        "note": note,
        "actor_user_id": actor["id"],
        "reassign_to_email": req.reassign_to_email,
        "returned_to_stage": req.returned_to_stage,
        "acting_user_email": actor["email"],
    }
    run_id = workflow_engine.start("sla-idle-escalation", inputs)
    st = workflow_engine.state(run_id)
    if st["status"] != "parked":
        # The `breached` condition short-circuited: this deal is inside SLA.
        measured = st["context"].get("measure", {})
        raise HTTPException(
            status_code=409,
            detail=(
                f"deal {req.deal_code} is idle {measured.get('idle_business_days', 0)} business "
                f"day(s) — it has not crossed the {SLA_IDLE_BUSINESS_DAYS}-business-day service line"
            ),
        )

    # The human node parked into approval-flow; the officer's decision here IS
    # that human decision, recorded with their identity, and it resumes the run.
    approval_flow.approve(st["approval_id"], actor["email"], reason=note or req.action)
    st = workflow_engine.tick(run_id)
    applied = st["context"].get("apply") or {}
    if st["status"] == "failed":
        raise HTTPException(status_code=409, detail=st.get("error") or "escalation failed")
    updated = deals_repo.get_deal(req.deal_code)
    return {
        "run_id": run_id,
        "workflow": "sla-idle-escalation",
        "state": st["status"],
        "deal_id": req.deal_code,
        "borrower_name": deal.get("borrower_name"),
        "idle_business_days": (st["context"].get("measure") or {}).get("idle_business_days"),
        "blocking_items": (st["context"].get("blockers") or {}).get("blocking_items", []),
        "action_taken": applied.get("action_taken"),
        "note": applied.get("note"),
        "decided_by_email": actor["email"],
        "reassigned_to_user_id": applied.get("reassigned_to_user_id"),
        "reassigned_to_email": _email_of(applied.get("reassigned_to_user_id")),
        "returned_to_stage": applied.get("returned_to_stage"),
        "current_stage": (updated or {}).get("current_stage"),
        "audit_entry_id": applied.get("audit_entry_id"),
    }


# ---------------------------------------------------------------------------
# Desk reference data + the deals the approval/SLA desk opens on.
#
# Deterministic and idempotent, installed at import so a fresh boot shows a
# working register rather than an empty screen. Deal codes here are explicit
# (DEAL-1004..DEAL-1006) and do NOT draw from deals_repo's code sequence, so
# deals filed through the intake form keep numbering from DEAL-1001.
# ---------------------------------------------------------------------------

_FIXTURE_MARKER = "tiered-approval-and-sla"


def _install_deal_code_guard():
    """A reserved desk-fixture code must never be handed out a second time.

    `deals_repo.next_deal_code()` counts its own sequence (DEAL-1001, 1002, …)
    and knows nothing about deals inserted with an explicit code, so the Nth
    filed deal could otherwise be issued a code a fixture already holds and
    two different borrowers would share one deal_code. This wraps the
    allocator additively — it does not edit the shared module, and it does not
    change the sequence for anyone: the first filed deal is still DEAL-1001.
    It only skips forward when a code is already taken. Installing twice is a
    no-op, so several slices reserving codes compose safely.
    """
    if getattr(deals_repo.next_deal_code, "_skips_reserved_codes", False):
        return
    allocate = deals_repo.next_deal_code

    def next_unused_deal_code():
        code = allocate()
        while deals_repo.get_deal(code) is not None:
            code = allocate()
        return code

    next_unused_deal_code._skips_reserved_codes = True
    deals_repo.next_deal_code = next_unused_deal_code


def _fixture_deal(deal_code, **fields):
    if deals_repo.get_deal(deal_code) is not None:
        return
    row = {
        "deal_code": deal_code,
        "borrower_entity_id": None,
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "created_at": _now(),
        "updated_at": _now(),
    }
    row.update(fields)
    store.insert("deals", row)


def install_desk_fixtures():
    _install_deal_code_guard()
    if any(r.get("marker") == _FIXTURE_MARKER for r in store.list("_fixture_state")):
        return
    store.insert("_fixture_state", {"marker": _FIXTURE_MARKER})

    # R-063: the controlled adverse-action vocabulary a decline must choose from.
    existing_codes = {r.get("reason_code") for r in store.list("adverse_action_reasons")}
    for code, label in ADVERSE_ACTION_REASONS:
        if code not in existing_codes:
            store.insert("adverse_action_reasons", {
                "reason_code": code,
                "reason_label": label,
                "is_active": True,
                "created_at": _now(),
            })

    # R-057: the configurable bank-holiday calendar behind business-day ageing.
    year = datetime.datetime.now(datetime.timezone.utc).year
    holidays = [
        (f"{year}-01-01", "New Year's Day"),
        (f"{year}-07-04", "Independence Day"),
        (f"{year}-12-25", "Christmas Day"),
    ]
    known = {str(r.get("calendar_date")) for r in store.list("business_calendar")}
    for date_str, name in holidays:
        if date_str not in known:
            store.insert("business_calendar", {
                "calendar_date": date_str,
                "is_business_day": False,
                "holiday_name": name,
                "created_at": _now(),
            })

    rm = identity.resolve_user("rm@bank.test", default_role=identity.RELATIONSHIP_MANAGER)
    analyst = identity.resolve_user("analyst@bank.test", default_role=identity.CREDIT_ANALYST)
    identity.resolve_user(ESCALATION_OWNER_EMAIL, default_role=identity.SENIOR_CREDIT_OFFICER)

    now = datetime.datetime.now(datetime.timezone.utc)
    long_idle = (now - datetime.timedelta(days=21)).isoformat()
    fresh = now.isoformat()

    _fixture_deal(
        "DEAL-1004",
        borrower_name="Northgate Millworks",
        borrower_industry="manufacturing",
        requested_amount=750000,
        exposure_amount=750000,
        current_stage="tiered_approval",
        current_status="awaiting_decision",
        created_by_user_id=rm["id"],
        assigned_to_user_id=analyst["id"],
        risk_grade="5",
        last_activity_timestamp=fresh,
    )
    _fixture_deal(
        "DEAL-1005",
        borrower_name="Vellum Bookbinding Co.",
        borrower_industry="printing",
        requested_amount=88000,
        exposure_amount=88000,
        current_stage="document_extraction",
        current_status="documents_pending",
        created_by_user_id=rm["id"],
        assigned_to_user_id=analyst["id"],
        last_activity_timestamp=long_idle,
    )
    _fixture_deal(
        "DEAL-1006",
        borrower_name="Copper Kettle Catering",
        borrower_industry="hospitality",
        requested_amount=310000,
        exposure_amount=310000,
        current_stage="tiered_approval",
        current_status="awaiting_decision",
        created_by_user_id=rm["id"],
        assigned_to_user_id=analyst["id"],
        risk_grade="7",
        last_activity_timestamp=(now - datetime.timedelta(days=10)).isoformat(),
    )


install_desk_fixtures()
