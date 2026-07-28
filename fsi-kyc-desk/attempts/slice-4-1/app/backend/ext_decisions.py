"""Slice 4 — role-based access and tiered human approval.

Approvals are gated by risk band and enforced server-side against named
individual accounts on the approved roster (kyc_policy.SEED_USERS), never a
role claimed in the request body: a Low-band decision requires kyc_analyst
(or higher), Medium requires senior_analyst (or higher), and High requires a
compliance_officer with a documented rationale. Rejections require a reason.
No auditor and no unroled/system-named caller may ever record a decision.
Every decision is immutable (one per case cycle — a second attempt is a 409,
never a silent overwrite) and carries the approver's identity, role at
decision time, timestamp, the memo version adopted and the next review due
date (REQ-040...049).

This module implements the human-decision half of the already-approved
`risk-memo-and-approval` workflow (workflows/workflows.json) — slice 3 built
load_case/draft_memo/persist_memo/validate_citations and parked at the human
`approval_decision` node; this registers the three handlers downstream of it:
`record_approval_decision`, `finalize_approved_case` and
`record_rejection_and_notify_relationship_team`.

Recorded deviation (discovered here, not introduced by this slice): the
scaffold's `workflow_engine.tick()` resolves a parked human node by reading
the approval_flow item's status only, and on anything other than "approved"
it immediately appends `run.failed` and returns — it never advances to a
workflow's own subsequent nodes (here, `record_decision` and its
`rejection_branch`/`record_rejection`). That makes the generic
park-then-tick path structurally unable to run this workflow's designed
rejection handling, and it also cannot carry a decision's rationale/reason
text into the resumed node's context at all (`tick()` forwards only
`{"approved", "by"}`). A decision must also be recordable for a case that has
never had a memo drafted against it (this slice's own acceptance decides
ACC-COMPLETE-001, which nothing here ever calls /memos/draft for), which the
one-parked-run-per-case model cannot address unambiguously when a case has
been drafted more than once (slice 3's acceptance drafts ACC-HIGH-001 twice,
leaving two independently-parked runs).

For all of these reasons, POST /decisions below is the authoritative,
self-contained entry point: it builds the same context shape a real workflow
run would have reached this node with and calls the three handler functions
directly, so the exact same code that is registered with workflow_engine (and
genuinely completes end-to-end through `tick()` on the *approve* path, which
`tick()` does support) is what records every decision. Deciding a case
auto-drafts a memo first if none exists yet for its current cycle — an
analyst or officer always has something to adopt — reusing the very same
`risk-memo-and-approval` workflow /memos/draft itself runs.

Composition contract:
  * storage -> db.store only (`approvals`, `compliance_exceptions`,
               `notifications`, `assessment_memos`, `audit_trail`; the
               `users` table is read-only display — kyc_policy.SEED_USERS /
               ext_cases.role_of remain the sole authority on who holds what)
  * process -> workflow_engine.register_handler for the three named handlers;
               reused directly (not just via tick) for the reasons above
  * audit   -> ext_audit.record + audit_trail, via ext_cases.audit
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in main.py
               can never shadow them
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import kyc_policy as policy
import workflow_engine
from db import store
from ext_cases import (
    acting_user,
    audit,
    case_by_id,
    find_case,
    machine_or_unroled,
    role_of,
    stamp_cycle,
)

router = APIRouter()


def _role_definition(role):
    return next((r for r in policy.ROLE_DEFINITIONS if r["role"] == role), None)


def _latest_memo(case_id, cycle):
    matches = [m for m in store.list("assessment_memos") if m["case_id"] == case_id and m.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


def _existing_decision(case_id, cycle):
    matches = [a for a in store.list("approvals") if a["case_id"] == case_id and a.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


def _ensure_memo_drafted(row, who):
    """A decision always has a memo to adopt — draft one on demand if needed.

    Reuses the exact same approved workflow /memos/draft itself runs
    (ext_memos.py's `risk-memo-and-approval`), so no memo logic is duplicated
    here; if one is already on file for this cycle, it is used as-is and
    nothing new is drafted.
    """
    cycle = row.get("cycle", 1)
    memo = _latest_memo(row["id"], cycle)
    if memo is not None:
        return memo
    if row.get("total_risk_score") is None:
        return None
    try:
        run_id = workflow_engine.start(
            "risk-memo-and-approval", {"case_reference": row["case_reference"], "requested_by": who}
        )
    except workflow_engine.WorkflowError:
        return None
    state = workflow_engine.state(run_id)
    if state.get("status") == "failed":
        return None
    return _latest_memo(row["id"], cycle)


# --------------------------------------------------------------------------
# Workflow handlers — the implementation contract of risk-memo-and-approval's
# human-decision half (record_decision, finalize_approval, record_rejection).
# Called directly by POST /decisions below (see module docstring), and also
# registered with workflow_engine so the *approve* path genuinely completes
# end to end if driven through /workflow + /workflows/runs/{id}/tick.
# --------------------------------------------------------------------------
def record_approval_decision(context):
    loaded = context.get("load_case") or {}
    decision_info = context.get("approval_decision") or {}
    case_id = loaded.get("case_id")
    row = case_by_id(case_id)
    if row is None:
        raise workflow_engine.WorkflowError("record decision: case not found")
    approved = bool(decision_info.get("approved"))
    who = decision_info.get("by")
    reason_text = decision_info.get("reason") or ""
    decided_by_role = role_of(who) or machine_or_unroled(who)
    required_role_tier = loaded.get("required_approver_role") or policy.required_approver_role(row.get("risk_band"))
    role_substitution = decided_by_role != required_role_tier
    now = policy.iso(policy.now_utc())
    cycle = row.get("cycle", 1)
    memo_version_id = (context.get("persist_memo") or {}).get("memo_version_id")
    approval_row = store.insert(
        "approvals",
        {
            "case_id": case_id,
            "cycle": cycle,
            "decision_type": "approve" if approved else "reject",
            "decided_by_user_id": who,
            "decided_by_role": decided_by_role,
            "decided_at": now,
            "required_role_tier": required_role_tier,
            "reason": reason_text,
            "memo_version_id": memo_version_id,
        },
    )
    entry = audit(
        case_id,
        "decision_recorded",
        who,
        field_name="decision",
        old_value=None,
        new_value="approved" if approved else "rejected",
        details={
            "required_role_tier": required_role_tier,
            "role_substitution": role_substitution,
            "reason": reason_text,
            "approval_id": approval_row["id"],
        },
    )
    return {
        "case_id": case_id,
        "approval_id": approval_row["id"],
        "decision": "approved" if approved else "rejected",
        "decided_by_user_id": who,
        "decided_by_role": decided_by_role,
        "required_role_tier": required_role_tier,
        "role_substitution": role_substitution,
        "decided_at": now,
        "reason": reason_text,
        "memo_version_id": memo_version_id,
        "case_status": row.get("status"),
        "audit_entry_id": entry["id"],
    }


def finalize_approved_case(context):
    decision = context.get("record_decision") or {}
    case_id = decision.get("case_id")
    row = case_by_id(case_id)
    if row is None:
        raise workflow_engine.WorkflowError("finalize approval: case not found")
    now_dt = policy.now_utc()
    now = policy.iso(now_dt)
    previous = row["status"]
    row["status"] = "approved"
    band = row.get("risk_band") or "medium"
    cadence_months = policy.REVIEW_CADENCE_MONTHS.get(band, 12)
    next_due = policy.add_months(now_dt, cadence_months)
    row["next_review_due_date"] = policy.iso(next_due)
    memo_version_id = decision.get("memo_version_id")
    memo_adopted = False
    if memo_version_id:
        for m in store.list("assessment_memos"):
            if m["id"] == memo_version_id:
                m.update(
                    approved_at=now,
                    approved_by_user_id=decision.get("decided_by_user_id"),
                    approved_by_role=decision.get("decided_by_role"),
                    is_approved=True,
                )
                memo_adopted = True
    stamp_cycle(
        case_id,
        decision="approved",
        decided_at=decision.get("decided_at"),
        decided_by_user_id=decision.get("decided_by_user_id"),
        decided_by_role=decision.get("decided_by_role"),
        status="approved",
    )
    entry = audit(
        case_id,
        "case_approved",
        decision.get("decided_by_user_id"),
        field_name="status",
        old_value=previous,
        new_value="approved",
        details={
            "memo_version_id": memo_version_id,
            "next_review_due_date": row["next_review_due_date"],
            "required_role_tier": decision.get("required_role_tier"),
        },
    )
    return {
        "case_id": case_id,
        "case_status": "approved",
        "memo_adopted": memo_adopted,
        "approved_memo_version_id": memo_version_id,
        "review_cadence": cadence_months,
        "next_review_due_date": row["next_review_due_date"],
        "audit_entry_id": entry["id"],
    }


def record_rejection_and_notify_relationship_team(context):
    decision = context.get("record_decision") or {}
    case_id = decision.get("case_id")
    row = case_by_id(case_id)
    if row is None:
        raise workflow_engine.WorkflowError("record rejection: case not found")
    now = policy.iso(policy.now_utc())
    previous = row["status"]
    row["status"] = "rejected"
    reason_text = decision.get("reason") or ""
    stamp_cycle(
        case_id,
        decision="rejected",
        decided_at=decision.get("decided_at"),
        decided_by_user_id=decision.get("decided_by_user_id"),
        decided_by_role=decision.get("decided_by_role"),
        status="rejected",
    )
    recipient = row.get("submitted_by") or "relationship-management-team"
    notification = store.insert(
        "notifications",
        {
            "case_id": case_id,
            "notification_type": "case_rejected",
            "recipient_user_id": recipient,
            "sent_at": now,
            "message": (
                f"Case {row['case_reference']} was rejected by {decision.get('decided_by_user_id')} "
                f"({decision.get('decided_by_role')}) — reason: {reason_text}. The relationship "
                "management team has been notified so the client can be informed."
            ),
            "read_at": None,
        },
    )
    entry = audit(
        case_id,
        "case_rejected",
        decision.get("decided_by_user_id"),
        field_name="status",
        old_value=previous,
        new_value="rejected",
        details={"reason": reason_text, "notification_id": notification["id"]},
    )
    return {
        "case_id": case_id,
        "case_status": "rejected",
        "rejection_reason": reason_text,
        "notification_id": notification["id"],
        "recipient_user_id": recipient,
        "audit_entry_id": entry["id"],
    }


for _name, _fn in [
    ("record_approval_decision", record_approval_decision),
    ("finalize_approved_case", finalize_approved_case),
    ("record_rejection_and_notify_relationship_team", record_rejection_and_notify_relationship_team),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# Endpoints (registered outside /api/ — never shadowed by the catch-all)
# --------------------------------------------------------------------------
class DecisionRequest(BaseModel):
    case_reference: str
    decision: str = ""
    acting_user: str = ""
    rationale: str = ""
    reason: str = ""


class ExceptionRequest(BaseModel):
    acting_user: str = ""
    document_type: str = ""
    reason: str = ""


@router.get("/roles")
def get_roles():
    """The tiers a decision is gated by (REQ-040...043) — who may decide what."""
    return {
        "roles": [dict(r) for r in policy.ROLE_DEFINITIONS],
        "bands": [dict(b) for b in policy.RISK_BANDS],
        "policy_exception_authority": "compliance_officer",
    }


@router.get("/users")
def get_users():
    """Named individual accounts the desk decides with — never anonymous (REQ-041)."""
    return {
        "users": [
            {
                "username": u.get("username"),
                "full_name": u.get("full_name"),
                "role": u.get("role"),
                "is_active": u.get("is_active"),
            }
            for u in store.list("users")
        ]
    }


@router.post("/decisions")
def record_decision_endpoint(req: DecisionRequest, authorization: str | None = Header(default=None)):
    """Record a tiered human decision — the single door a case's status changes through."""
    row = find_case(req.case_reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{req.case_reference}'")
    decision = (req.decision or "").strip().lower()
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'reject'")
    cycle = row.get("cycle", 1)
    if _existing_decision(row["id"], cycle) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a decision has already been recorded for '{row['case_reference']}' at cycle {cycle}",
        )
    if row.get("status") != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"case is '{row.get('status')}' — only a ready, scored case can be decided",
        )
    who = acting_user(authorization, req.acting_user) or "unknown"
    role = role_of(who)
    role_def = _role_definition(role) if role else None
    band = row.get("risk_band") or "medium"
    required_role = policy.required_approver_role(band)
    if role_def is None or not role_def.get("may_decide"):
        raise HTTPException(
            status_code=403,
            detail=(
                f"'{who}' holds no role authorised to record case decisions "
                f"(this case is band '{band}', which requires a '{required_role}' decision)."
            ),
        )
    if band not in (role_def.get("approves_bands") or []):
        raise HTTPException(
            status_code=403,
            detail=(
                f"case '{row['case_reference']}' is band '{band}', which requires a '{required_role}' "
                f"decision; '{who}' holds role '{role}'."
            ),
        )
    field_name = "rationale" if decision == "approve" else "reason"
    reason_text = (req.rationale if decision == "approve" else req.reason or "").strip()
    if not reason_text:
        raise HTTPException(status_code=400, detail=f"a documented {field_name} is required to record this decision")

    memo = _ensure_memo_drafted(row, who)
    context = {
        "load_case": {
            "case_id": row["id"],
            "case_reference": row["case_reference"],
            "risk_band": band,
            "required_approver_role": required_role,
        },
        "persist_memo": {
            "memo_version_id": memo["id"] if memo else None,
            "version": memo["version"] if memo else None,
        },
        "approval_decision": {"approved": decision == "approve", "by": who, "reason": reason_text},
    }
    decision_out = record_approval_decision(context)
    context["record_decision"] = decision_out
    if decision_out["decision"] == "approved":
        final = finalize_approved_case(context)
        return {
            "case_reference": row["case_reference"],
            "status": "approved",
            "decided_by_user_id": decision_out["decided_by_user_id"],
            "decided_by_role": decision_out["decided_by_role"],
            "required_role_tier": decision_out["required_role_tier"],
            "role_substitution": decision_out["role_substitution"],
            "decided_at": decision_out["decided_at"],
            "memo_version_id": decision_out["memo_version_id"],
            "next_review_due_date": final["next_review_due_date"],
            "audit_entry_id": final["audit_entry_id"],
        }
    final = record_rejection_and_notify_relationship_team(context)
    return {
        "case_reference": row["case_reference"],
        "status": "rejected",
        "decided_by_user_id": decision_out["decided_by_user_id"],
        "decided_by_role": decision_out["decided_by_role"],
        "required_role_tier": decision_out["required_role_tier"],
        "decided_at": decision_out["decided_at"],
        "rejection_reason": final["rejection_reason"],
        "notification_id": final["notification_id"],
        "recipient_user_id": final["recipient_user_id"],
        "audit_entry_id": final["audit_entry_id"],
    }


@router.get("/notifications")
def list_notifications(case_reference: str | None = None):
    """Every at-risk, escalation and rejection notice — addressable, never ephemeral (REQ-062)."""
    rows = store.list("notifications")
    if case_reference:
        target = find_case(case_reference)
        target_id = target["id"] if target else None
        rows = [n for n in rows if n["case_id"] == target_id]
    enriched = []
    for n in rows:
        case_row = case_by_id(n["case_id"])
        enriched.append(dict(n, case_reference=(case_row or {}).get("case_reference")))
    return {"notifications": enriched, "count": len(enriched)}


@router.post("/cases/{reference}/exceptions")
def grant_policy_exception(reference: str, req: ExceptionRequest, authorization: str | None = Header(default=None)):
    """Only a compliance_officer may record a documented policy exception (REQ-075/REQ-088)."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    who = acting_user(authorization, req.acting_user) or "unknown"
    role = role_of(who)
    if role != "compliance_officer":
        audit(
            row["id"],
            "exception_refused",
            who,
            field_name="document_type",
            old_value=req.document_type,
            new_value="refused",
            details={"reason": "only a compliance_officer may record a documented policy exception"},
        )
        raise HTTPException(
            status_code=403,
            detail="Only a compliance_officer may record a documented policy exception against the case.",
        )
    if not (req.document_type or "").strip():
        raise HTTPException(status_code=400, detail="document_type is required")
    if not (req.reason or "").strip():
        raise HTTPException(status_code=400, detail="a documented reason is required to grant a policy exception")
    now = policy.iso(policy.now_utc())
    exc = store.insert(
        "compliance_exceptions",
        {
            "case_id": row["id"],
            "exception_type": "document_requirement_exception",
            "granted_by_user_id": who,
            "granted_at": now,
            "reason": req.reason,
            "affected_documents": [req.document_type],
        },
    )
    entry = audit(
        row["id"],
        "exception_granted",
        who,
        field_name="document_type",
        old_value=None,
        new_value=req.document_type,
        details={"reason": req.reason, "exception_id": exc["id"]},
    )
    return {
        "case_reference": row["case_reference"],
        "exception_id": exc["id"],
        "granted_by_user_id": who,
        "document_type": req.document_type,
        "reason": req.reason,
        "granted_at": now,
        "audit_entry_id": entry["id"],
    }


@router.get("/audit/cases/{reference}")
def case_audit_trail(reference: str, acting_user: str | None = None):
    """A case's full chronological trail, before/after values included (REQ-064/065)."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    entries = [e for e in store.list("audit_trail") if e["case_id"] == row["id"]]
    entries.sort(key=lambda e: e["id"])
    return {"case_reference": row["case_reference"], "count": len(entries), "entries": entries, "viewed_by": acting_user}


@router.post("/audit/entries/{entry_id}/delete")
def delete_audit_entry(entry_id: int):
    """The register has no eraser (REQ-066) — there is no such operation."""
    raise HTTPException(
        status_code=404,
        detail="audit trail entries are immutable and append-only; no delete operation exists",
    )
