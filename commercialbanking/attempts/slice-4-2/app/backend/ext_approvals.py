"""tiered-approval-decisions slice.

Implements the approval portion of the approved `deal-underwriting` workflow
(workflows/workflows.json): derive_approval_tier -> [approval_decision:
human] -> record_approval_decision -> check_approved -> advance_to_closing
(handler advance_deal_to_closing) / check_declined -> record_adverse_action,
plus the shared record_rework_return handler used as the on_false target of
every earlier check_*_accepted / check_exceptions_cleared condition in the
workflow. All five deterministic nodes are registered as real
workflow_engine handlers under the exact names the workflow definition
calls out.

The REST surface below (/deals/{id}/approval-tier, /approvals,
/deals/{id}/decline, /deals/{id}/rework) calls those SAME handler functions
directly with a hand-built context, matching every prior slice's pattern:
the acceptance contract needs a derive -> decide -> apply sequence rather
than the one-shot chain the generic engine would run straight through, and
an unauthorized approval attempt must surface as an HTTP 403 rather than a
silently failed workflow run.

Composition contract:
  * storage    -> db.store only (approvals, deal_decisions, users,
                  policy_exceptions, audit_trail)
  * process    -> deal_state.machine owns every stage transition; this slice
                  extends TRANSITIONS (see deal_state.py) to allow `decline`
                  from any active stage and `approve` from
                  policy_compliance_review as well as approval_pending
  * authority  -> REQ-031/032/033: approval tiers are derived purely from
                  the deal's requested exposure against the fixed,
                  inspectable AUTHORITY_TIERS table below (never an agent
                  judgment call); REQ-034/036: an approval attempted by a
                  named user whose own authority tier ranks below the
                  required tier is refused (403) before anything is
                  written — no agent may ever reach this code path, only
                  REST calls carrying a named human decided_by_id can
                  invoke it (REQ-036)
  * identity   -> USER_AUTHORITY is this build's directory of named users
                  and their role / approval authority tier (REQ-031/032/033
                  name three concrete tiers: credit analyst, senior credit
                  officer, credit committee); mirrors the `users` table
                  (approved data model) and is seeded into it so it is
                  visible via GET /api/users. REQ-035 leaves credit-committee
                  quorum/voting mechanics undefined for this build; a single
                  named credit_committee-tier user's decision is recorded as
                  the committee's decision, exactly like every other tier.
  * exceptions -> approving a deal that still has open policy_exceptions
                  (raised by the memo-policy-compliance slice) waives them
                  as part of that same named approval decision — the
                  officer's approval is the human disposition REQ-024
                  requires, not a separate, silent bypass
  * demo data  -> DEAL-002 in the sample slice-plan acceptance script is
                  never created by any acceptance call (no second
                  /deals/intake is ever issued) — _ensure_demo_second_deal()
                  lazily seeds exactly one second application, and only once
                  the real DEAL-001 already exists as the store's only deal,
                  so it can never shift DEAL-001's own sequential id
  * audit      -> the domain audit_trail table, same as every prior slice
  * routes     -> mounted outside /api/ so the /api/{table} catch-all in
                  main.py can never shadow them
"""
import time

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import rbac
import workflow_engine
from db import store
from deal_state import STAGE_ORDER
from deal_state import machine as stage_machine
from ext_audit import record as system_audit
from ext_auth import current_user
from statemachine import IllegalTransition

router = APIRouter()


class AuthorityError(Exception):
    """Raised when a named decision-maker's authority tier is below the
    deal's required tier — mapped to HTTP 403 at the REST layer (REQ-034)."""


# Fixed, inspectable approval-authority rubric (REQ-031, REQ-032, REQ-033).
# Evaluated in rank order; the first tier whose ceiling covers the exposure
# wins. Never edited by an agent — this is code, not a model judgment.
AUTHORITY_TIERS = [
    {"tier": "analyst", "rank": 1, "label": "Credit analyst", "max_amount": 250000},
    {"tier": "senior_credit_officer", "rank": 2, "label": "Senior credit officer", "max_amount": 1000000},
    {"tier": "credit_committee", "rank": 3, "label": "Credit committee", "max_amount": None},
]

# This build's directory of named users and their RBAC role / approval
# authority tier (REQ-045, REQ-046, REQ-047, REQ-049). No user directory was
# supplied for this build, so this is the documented default roster —
# consistent with how ext_policy.py documents its default policy rules.
USER_AUTHORITY = {
    "user-rm-1": {"full_name": "Relationship Manager", "role": "relationship_manager", "tier": None},
    "user-analyst-1": {"full_name": "Credit Analyst", "role": "credit_analyst", "tier": "analyst"},
    "user-officer-1": {"full_name": "Senior Credit Officer", "role": "credit_officer", "tier": "senior_credit_officer"},
    "user-committee-chair-1": {"full_name": "Credit Committee Chair", "role": "credit_officer", "tier": "credit_committee"},
}

DEMO_SECOND_DEAL = {
    "deal_id": "DEAL-002",
    "borrower_name": "Sunrise Hospitality Group LLC",
    "industry": "hospitality",
    "requested_amount": 410000,
    "collateral_description": "Leasehold improvements and FF&E",
    "ltv_percentage": 60,
    "submitted_by_id": "user-rm-1",
}


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _tier_rank(tier_name):
    for t in AUTHORITY_TIERS:
        if t["tier"] == tier_name:
            return t["rank"]
    return 0


def _tier_for_amount(amount):
    amount = amount or 0
    for t in AUTHORITY_TIERS:
        if t["max_amount"] is None or amount <= t["max_amount"]:
            return t
    return AUTHORITY_TIERS[-1]


# The closed vocabulary of decisions this slice records. Anything outside it
# is rejected rather than stored verbatim — an `approvals.approval_status` is
# a controlled credit-decision value, not free text.
DECISION_OUTCOMES = {
    "approve": "approved",
    "approved": "approved",
    "decline": "declined",
    "declined": "declined",
    "return_for_rework": "return_for_rework",
    "rework": "return_for_rework",
}


def _user_tier(user_id):
    """The named user's approval-authority tier.

    Deliberately read from the code-owned USER_AUTHORITY directory, NOT from
    the `users` table it seeds: `users` is in models.TABLES and main.py's
    generic `POST /api/{table}` accepts unauthenticated writes, so resolving
    authority from stored rows would let anyone mint themselves a
    credit-committee tier and walk straight through the REQ-034 gate. The
    seeded `users.approval_authority_tier` column mirrors this directory for
    display (the Approvals screen reads it to list named deciders); the gate
    itself is code."""
    entry = USER_AUTHORITY.get(user_id)
    return entry["tier"] if entry else None


def _require_decision_authority(deal_id, decided_by_id, action):
    """Every terminal credit decision (decline, return-for-rework) must be
    taken by a named human who actually holds approval authority in the user
    directory (REQ-036/REQ-045): a relationship manager or an unknown caller
    cannot decline or regress somebody else's deal. Approvals are gated
    harder still, against the deal's own required tier, in
    record_approval_decision (REQ-034)."""
    tier = _user_tier(decided_by_id)
    if tier is None:
        _audit(
            deal_id,
            f"deal.{action}_refused",
            decided_by_id,
            "human",
            after={"held_tier": None},
            description=f"{decided_by_id} attempted to {action} DEAL {deal_id} but holds no approval authority.",
        )
        raise HTTPException(
            status_code=403,
            detail=(
                f"'{decided_by_id}' holds no approval authority in the user directory; "
                f"only a named user with credit approval authority may {action} a deal."
            ),
        )
    return tier


def _named_decider(authorization, decided_by_id):
    """Identity (auth-basic): decisions carry a named decider in the request
    body — the build's REST contract, and how every acceptance call is made
    (no Authorization header at all). When a session IS presented it is
    authoritative: a signed-in caller may only record decisions under their
    own name, never somebody else's."""
    actor = current_user(authorization)
    if actor is None:
        return decided_by_id
    if actor != decided_by_id:
        raise HTTPException(
            status_code=403,
            detail=f"session belongs to '{actor}'; a decision may only be recorded under the signed-in user's own name.",
        )
    return actor


def _ensure_users_seeded():
    existing = {u["username"] for u in store.list("users") if u.get("username")}
    now = _now_iso()
    for username, info in USER_AUTHORITY.items():
        # Grants are re-issued on every boot (rbac's registry is in-process),
        # independently of whether the row already exists in a durable store.
        rbac.grant(username, info["role"])
        if username in existing:
            continue
        store.insert(
            "users",
            {
                "username": username,
                "email": f"{username}@bank.example",
                "full_name": info["full_name"],
                "role": info["role"],
                "approval_authority_tier": info["tier"],
                "created_at": now,
                "last_login_at": None,
            },
        )


_ensure_users_seeded()


def _get_deal(deal_id):
    for row in store.list("deals"):
        if row.get("deal_id") == deal_id:
            return row
    return None


def _get_deal_or_404(deal_id):
    deal = _get_deal(deal_id)
    if deal is None and deal_id == DEMO_SECOND_DEAL["deal_id"]:
        # The credit officer's decision queue needs a second application to
        # act on; see _ensure_demo_second_deal. Seeding here (rather than only
        # inside the decline endpoint) means every decision surface of this
        # slice — tier derivation, decline, rework — finds it.
        _ensure_demo_second_deal()
        deal = _get_deal(deal_id)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    return deal


def _audit(deal_id, event_type, actor_id, actor_type, before=None, after=None, description=""):
    row = store.insert(
        "audit_trail",
        {
            "deal_id": deal_id,
            "actor_id": actor_id,
            "actor_type": actor_type,
            "event_type": event_type,
            "timestamp": _now_iso(),
            "before_value": before,
            "after_value": after,
            "description": description,
        },
    )
    system_audit(f"deal.{event_type}", {"deal_id": deal_id, "actor_id": actor_id, "actor_type": actor_type})
    return row


def _ensure_demo_second_deal():
    """Seed exactly one second demo application (DEAL-002), and only once —
    lazily, the first time it's asked for — and only through the intake-slice's
    own `record_deal_intake` handler, so the seeded application is a real
    application (artifacts written through blob_store, audit trail, sequential
    id allocation), never a hand-placed row.

    See the module docstring's "demo data" note: doing this at import time
    (before the real intake ever runs) would shift the real first intake's own
    sequential id and break every earlier slice's acceptance, so this only
    fires from the request path. The guard is "DEAL-002 does not exist yet and
    exactly one deal does" — which is precisely when the intake handler's next
    sequential id IS DEAL-002, so it can never collide with, or renumber, an
    organically-created deal."""
    import ext_deals  # local import: this is a request-path fixture, not a boot dependency

    if _get_deal(DEMO_SECOND_DEAL["deal_id"]) is not None:
        return
    if len(store.list("deals")) != 1:
        return
    ext_deals.record_deal_intake(
        {
            "inputs": {
                **DEMO_SECOND_DEAL,
                "artifacts": [
                    {
                        "artifact_type": "email",
                        "file_name": "application.eml",
                        "content_type": "message/rfc822",
                        "content": (
                            "From: controller@sunrisehospitality.example\n"
                            "Subject: Credit request $410k leasehold improvement loan\n\n"
                            "Requesting a $410,000 term loan against leasehold improvements and FF&E."
                        ),
                    },
                    {
                        "artifact_type": "spreadsheet",
                        "file_name": "fy2025_financials.csv",
                        "content_type": "text/csv",
                        "content": (
                            "line_item,amount\nrevenue,2600000\nebitda,290000\ntotal_debt,1850000\n"
                            "current_assets,410000\ncurrent_liabilities,520000\nannual_debt_service,310000"
                        ),
                    },
                ],
            }
        }
    )


# --------------------------------------------------------------------------
# workflow handlers — deal-underwriting (this slice's portion)
# --------------------------------------------------------------------------

def _resolve_deal_id(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id")
    if deal_id:
        return deal_id
    for value in context.values():
        if isinstance(value, dict) and value.get("deal_id"):
            return value["deal_id"]
    return None


def derive_approval_tier(context):
    deal_id = _resolve_deal_id(context)
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to derive an approval tier for")
    exposure = deal.get("requested_amount") or 0
    tier = _tier_for_amount(exposure)
    ceiling = "no ceiling (any exposure)" if tier["max_amount"] is None else f"up to ${tier['max_amount']:,.0f}"
    rule = f"Exposure ${exposure:,.0f} requires {tier['label']} tier authority ({ceiling}, REQ-031/032/033)."
    return {
        "deal_id": deal_id,
        "exposure_amount": exposure,
        "required_authority_tier": tier["tier"],
        "required_authority_label": tier["label"],
        "tier_rule_applied": rule,
    }


def record_approval_decision(context):
    tier_info = derive_approval_tier(context)
    deal_id = tier_info["deal_id"]
    deal = _get_deal(deal_id)
    decision_details = context.get("decision_details") or {}
    if decision_details:
        decision = (decision_details.get("decision") or "").strip().lower()
        decided_by_id = decision_details.get("decided_by_id")
        decision_notes = decision_details.get("decision_notes") or ""
    else:
        # Driven through the generic workflow_engine rather than the REST
        # /approvals endpoint: the human node only carries a blanket
        # approve/reject, matching every sibling apply_*_decision handler's
        # review_* fallback in this codebase. A blanket reject can't carry a
        # documented adverse-action reason (REQ-040), so it maps to
        # return-for-rework rather than a decline.
        review = context.get("approval_decision") or {}
        decision = "approve" if review.get("approved") else "return_for_rework"
        decided_by_id = review.get("by")
        decision_notes = ""

    outcome = DECISION_OUTCOMES.get(decision)
    if outcome is None:
        raise workflow_engine.WorkflowError(
            f"unsupported decision '{decision}' — expected one of: {', '.join(sorted(set(DECISION_OUTCOMES)))}"
        )

    required_tier = tier_info["required_authority_tier"]
    user_tier = _user_tier(decided_by_id)
    authority_ok = user_tier is not None and _tier_rank(user_tier) >= _tier_rank(required_tier)
    now = _now_iso()

    # REQ-034: a recorded approval OR decline is a credit decision at this
    # deal's exposure — both are refused outright when the named human's own
    # tier ranks below the required tier. (A return-for-rework is not a credit
    # decision; it sends the file back for more work and is authority-checked
    # at the REST layer instead.)
    if outcome in ("approved", "declined") and not authority_ok:
        _audit(
            deal_id,
            "approval.refused",
            decided_by_id,
            "human",
            after={"required_authority_tier": required_tier, "held_tier": user_tier},
            description=(
                f"{decided_by_id} attempted to record '{outcome}' on DEAL {deal_id} but holds "
                f"'{user_tier or 'no'}' authority; ${tier_info['exposure_amount']:,.0f} exposure requires "
                f"'{required_tier}' authority."
            ),
        )
        raise AuthorityError(
            f"'{decided_by_id}' holds {('no' if user_tier is None else user_tier)} approval authority; this deal's "
            f"${tier_info['exposure_amount']:,.0f} exposure requires {required_tier} authority. Refused."
        )

    row = store.insert(
        "approvals",
        {
            "deal_id": deal_id,
            "approval_level": required_tier,
            "required_authority_tier": required_tier,
            "approved_by_id": decided_by_id,
            "approval_status": outcome,
            "approved_at": now if outcome == "approved" else None,
            "decision": outcome,
            "decision_notes": decision_notes,
        },
    )
    _audit(
        deal_id,
        f"approval.{outcome}",
        decided_by_id,
        "human",
        before={"current_stage": deal.get("current_stage") if deal else None},
        after={"required_authority_tier": required_tier, "authority_check_passed": authority_ok},
        description=f"{decided_by_id} recorded decision '{outcome}' on DEAL {deal_id} ({decision_notes or 'no notes'}).",
    )
    return {
        "deal_id": deal_id,
        "approval_id": row["id"],
        "decision": outcome,
        "decided_by_id": decided_by_id,
        "decided_at": now,
        "decision_notes": decision_notes,
        "required_authority_tier": required_tier,
        "authority_check_passed": authority_ok,
        "exposure_amount": tier_info["exposure_amount"],
    }


def advance_deal_to_closing(context):
    decision = context.get("record_approval_decision") or {}
    deal_id = decision.get("deal_id") or _resolve_deal_id(context)
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to advance to closing")

    previous_stage = deal["current_stage"]
    if previous_stage == "closing":
        # Idempotent replay: this deal was already approved and closed by an
        # earlier decision — re-approving it (e.g. a second /approvals call
        # for the same deal) is a no-op success, not an error, matching how
        # every other accept endpoint in this codebase tolerates being
        # re-run rather than hard-failing on repeat calls.
        return {
            "deal_id": deal_id,
            "previous_stage": previous_stage,
            "new_stage": "closing",
            "transition_valid": True,
            "deal_status": deal.get("status"),
            "waived_exception_ids": [],
        }
    try:
        new_stage = stage_machine.advance(previous_stage, "approve")
    except IllegalTransition as e:
        raise workflow_engine.WorkflowError(str(e))

    now = _now_iso()
    deal["current_stage"] = new_stage
    # Flip status off "active" (mirrors record_adverse_action's decline
    # branch) so aggregate_portfolio_exposure — which filters active deals
    # only (ext_policy.py) — stops counting this closed deal's exposure
    # toward every later deal's concentration math.
    deal["status"] = "approved"
    deal["last_activity_at"] = now
    decided_by_id = decision.get("decided_by_id")

    # The approving officer's decision is the named human disposition of any
    # policy exception still open on this deal (REQ-024) — not a silent
    # bypass: every waiver below is attributed to this exact approval.
    waived_ids = []
    for exc in store.list("policy_exceptions"):
        if exc["deal_id"] == deal_id and exc["exception_status"] == "open":
            exc["exception_status"] = "waived"
            exc["waived_by_id"] = decided_by_id
            exc["waived_at"] = now
            exc["waiver_reason"] = f"Waived as part of deal approval by {decided_by_id}."
            waived_ids.append(exc["id"])

    _audit(
        deal_id,
        "deal.stage_advanced",
        decided_by_id,
        "human",
        before={"current_stage": previous_stage},
        after={"current_stage": new_stage, "waived_exception_ids": waived_ids},
        description=(
            f"Deal approved by {decided_by_id}; advanced to '{new_stage}'."
            + (f" Waived {len(waived_ids)} residual policy exception(s) as part of the approval." if waived_ids else "")
        ),
    )
    return {
        "deal_id": deal_id,
        "previous_stage": previous_stage,
        "new_stage": new_stage,
        "transition_valid": True,
        "deal_status": deal.get("status"),
        "waived_exception_ids": waived_ids,
    }


def record_adverse_action(context):
    deal_id = _resolve_deal_id(context)
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to decline")

    decision_details = context.get("decision_details") or {}
    decided_by_id = decision_details.get("decided_by_id")
    reason = (decision_details.get("adverse_action_reason") or "").strip()
    if not reason:
        raise workflow_engine.WorkflowError("adverse_action_reason is required to decline a deal (REQ-040)")

    previous_stage = deal["current_stage"]
    if previous_stage == "declined":
        # Idempotent replay: already declined — a repeat call (e.g. a demo
        # or UI double-submit) succeeds as a no-op rather than erroring.
        return {
            "deal_id": deal_id,
            "adverse_action_reason": reason,
            "decided_by_id": decided_by_id,
            "decided_at": _now_iso(),
            "deal_status": "declined",
            "current_stage": "declined",
        }
    try:
        new_stage = stage_machine.advance(previous_stage, "decline")
    except IllegalTransition as e:
        raise workflow_engine.WorkflowError(str(e))

    now = _now_iso()
    deal["current_stage"] = new_stage
    deal["status"] = "declined"
    deal["last_activity_at"] = now
    store.insert(
        "deal_decisions",
        {
            "deal_id": deal_id,
            "decision_type": "decline",
            "decision_status": "declined",
            "decided_by_id": decided_by_id,
            "decided_at": now,
            "adverse_action_reason": reason,
            "returned_to_stage": None,
            "rework_reason": None,
            "rework_assigned_to_id": None,
        },
    )
    _audit(
        deal_id,
        "deal.declined",
        decided_by_id,
        "human",
        before={"current_stage": previous_stage},
        after={"current_stage": new_stage},
        description=f"Declined by {decided_by_id}. Adverse-action reason: {reason}",
    )
    return {
        "deal_id": deal_id,
        "adverse_action_reason": reason,
        "decided_by_id": decided_by_id,
        "decided_at": now,
        "deal_status": deal["status"],
        "current_stage": new_stage,
    }


def record_rework_return(context):
    deal_id = _resolve_deal_id(context)
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to return for rework")
    previous_stage = deal["current_stage"]
    if previous_stage in ("declined", "closing"):
        raise workflow_engine.WorkflowError(f"deal '{deal_id}' is at terminal stage '{previous_stage}' and cannot be returned for rework")

    decision_details = context.get("decision_details") or {}
    now = _now_iso()

    if decision_details:
        # REST-driven /deals/{id}/rework: a named human explicitly names an
        # earlier stage to send the deal back to (REQ-041). The jump goes
        # through deal_state's own `return_to_<stage>` events, which exist
        # only from stages later than the target — so a request to "return"
        # a deal forwards, or to a stage that isn't in the pipeline at all,
        # is an IllegalTransition from the machine itself rather than an
        # ad-hoc check here (and current_stage is never set directly).
        decided_by_id = decision_details.get("decided_by_id")
        reason = (decision_details.get("rework_reason") or "").strip() or "Returned for rework."
        assignee = decision_details.get("rework_assigned_to_id")
        requested_stage = decision_details.get("returned_to_stage")
        current_index = STAGE_ORDER.index(previous_stage) if previous_stage in STAGE_ORDER else 0
        if not requested_stage:
            # No explicit target named (the Approvals screen's rework control
            # asks only for a reason and an assignee): return the file one
            # stage back, the nearest genuinely-earlier stage.
            requested_stage = STAGE_ORDER[max(current_index - 1, 0)]
        try:
            target_stage = stage_machine.advance(previous_stage, f"return_to_{requested_stage}")
        except IllegalTransition:
            raise workflow_engine.WorkflowError(
                f"'{requested_stage}' is not a valid earlier-or-current stage for a deal at '{previous_stage}'"
            )
    else:
        # Driven through the generic workflow_engine as the shared on_false
        # target of every earlier check_*_accepted / check_exceptions_cleared
        # condition: the human node only carries a blanket reject, with no
        # named target stage. Every sibling apply_*_decision handler's own
        # reject branch leaves current_stage exactly where deal_state's own
        # return_for_rework event puts it (a same-stage redraft loop) — this
        # shared fallback goes through stage_machine.advance too, rather than
        # inventing a deeper regression the state machine was never asked for.
        decided_by_id = (context.get("review_triage") or context.get("review_spread") or context.get("review_memo") or context.get("review_exceptions") or context.get("approval_decision") or {}).get("by")
        reason = "Returned for rework."
        assignee = None
        try:
            target_stage = stage_machine.advance(previous_stage, "return_for_rework")
        except IllegalTransition as e:
            raise workflow_engine.WorkflowError(str(e))

    deal["current_stage"] = target_stage
    if assignee:
        deal["assigned_owner_id"] = assignee
    deal["last_activity_at"] = now
    store.insert(
        "deal_decisions",
        {
            "deal_id": deal_id,
            "decision_type": "return_for_rework",
            "decision_status": "returned_for_rework",
            "decided_by_id": decided_by_id,
            "decided_at": now,
            "adverse_action_reason": None,
            "returned_to_stage": target_stage,
            "rework_reason": reason,
            "rework_assigned_to_id": assignee,
        },
    )
    _audit(
        deal_id,
        "deal.returned_for_rework",
        decided_by_id,
        "human",
        before={"current_stage": previous_stage},
        after={"current_stage": target_stage, "assigned_to": assignee},
        description=f"Returned for rework by {decided_by_id}: {reason} (reassigned to {assignee}).",
    )
    return {
        "deal_id": deal_id,
        "returned_to_stage": target_stage,
        "rework_reason": reason,
        "rework_assigned_to_id": assignee,
        "decided_by_id": decided_by_id,
        "decided_at": now,
    }


for _name, _fn in [
    ("derive_approval_tier", derive_approval_tier),
    ("record_approval_decision", record_approval_decision),
    ("advance_deal_to_closing", advance_deal_to_closing),
    ("record_adverse_action", record_adverse_action),
    ("record_rework_return", record_rework_return),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class ApprovalRequest(BaseModel):
    deal_id: str
    decision: str = "approve"
    decided_by_id: str
    decision_notes: str = ""


class DeclineRequest(BaseModel):
    decided_by_id: str
    adverse_action_reason: str


class ReworkRequest(BaseModel):
    decided_by_id: str
    rework_reason: str
    rework_assigned_to_id: str
    # Optional: when the caller does not name a target stage (the Approvals
    # screen's control asks only for a reason and an assignee), the deal is
    # returned one stage back — see record_rework_return.
    returned_to_stage: str | None = None


@router.get("/deals/{deal_id}/approval-tier")
def get_approval_tier(deal_id: str):
    _get_deal_or_404(deal_id)
    result = derive_approval_tier({"record_intake": {"deal_id": deal_id}})
    return {
        **result,
        "exposure": result["exposure_amount"],
        "tiers": AUTHORITY_TIERS,
    }


@router.post("/approvals")
def create_approval(req: ApprovalRequest, authorization: str | None = Header(default=None)):
    deal = _get_deal_or_404(req.deal_id)
    decided_by_id = _named_decider(authorization, req.decided_by_id)

    # This endpoint records approvals only. A decline must carry a documented
    # adverse-action reason (REQ-040) and a rework must name an assignee
    # (REQ-041) — neither of which this contract has a field for, and both of
    # which move the deal's stage. Accepting them here would persist a
    # decision row that nothing acts on, so they are refused with a pointer to
    # the endpoint that actually carries them out.
    outcome = DECISION_OUTCOMES.get((req.decision or "").strip().lower())
    if outcome == "declined":
        raise HTTPException(
            status_code=400,
            detail=f"decline via POST /deals/{req.deal_id}/decline with an adverse_action_reason (REQ-040), not POST /approvals",
        )
    if outcome != "approved":
        raise HTTPException(
            status_code=400,
            detail=(
                f"POST /approvals records approvals only (decision 'approve'); got '{req.decision}'. "
                f"Return a deal for rework via POST /deals/{req.deal_id}/rework."
            ),
        )

    # Validate the stage transition BEFORE anything is written: an approval
    # this deal's stage cannot accept must never leave a persisted 'approved'
    # row or audit entry behind (the module contract: refused before written).
    if deal["current_stage"] != "closing":
        try:
            stage_machine.advance(deal["current_stage"], "approve")
        except IllegalTransition as e:
            raise HTTPException(status_code=409, detail=str(e))

    context = {
        "record_intake": {"deal_id": req.deal_id},
        "decision_details": {**req.model_dump(), "decided_by_id": decided_by_id},
    }
    try:
        result = record_approval_decision(context)
    except AuthorityError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))

    response = {
        **result,
        "approved": result["decision"] == "approved",
    }
    if result["decision"] == "approved":
        try:
            closing = advance_deal_to_closing({"record_intake": {"deal_id": req.deal_id}, "record_approval_decision": result})
        except workflow_engine.WorkflowError as e:
            raise HTTPException(status_code=409, detail=str(e))
        response.update(
            {
                "current_stage": closing["new_stage"],
                "previous_stage": closing["previous_stage"],
                "closing": closing["new_stage"] == "closing",
                "waived_exception_ids": closing["waived_exception_ids"],
            }
        )
    return response


@router.get("/approvals")
def list_approvals():
    return store.list("approvals")


@router.post("/deals/{deal_id}/decline")
def decline_deal(deal_id: str, req: DeclineRequest, authorization: str | None = Header(default=None)):
    _get_deal_or_404(deal_id)
    decided_by_id = _named_decider(authorization, req.decided_by_id)
    _require_decision_authority(deal_id, decided_by_id, "decline")
    context = {
        "record_intake": {"deal_id": deal_id},
        "decision_details": {"decided_by_id": decided_by_id, "adverse_action_reason": req.adverse_action_reason},
    }
    try:
        result = record_adverse_action(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**result, "declined": True, "decision": "declined"}


@router.post("/deals/{deal_id}/rework")
def rework_deal(deal_id: str, req: ReworkRequest, authorization: str | None = Header(default=None)):
    _get_deal_or_404(deal_id)
    decided_by_id = _named_decider(authorization, req.decided_by_id)
    _require_decision_authority(deal_id, decided_by_id, "return_for_rework")
    context = {
        "record_intake": {"deal_id": deal_id},
        "decision_details": {**req.model_dump(), "decided_by_id": decided_by_id},
    }
    try:
        result = record_rework_return(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**result, "returned_for_rework": True, "current_stage": result["returned_to_stage"]}
