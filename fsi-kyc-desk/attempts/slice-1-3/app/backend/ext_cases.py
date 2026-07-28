"""Slice 1 — case intake and the deterministic document completeness check.

Everything here is mechanical: a submission opens a case, the package is
checked against the versioned Document Checklist, a complete package moves the
case to READY (and is scored and put under an SLA clock by the same approved
workflow), an incomplete package is RETURNED with the itemised list of exactly
which documents are missing. No role can waive a required item.

Composition contract:
  * storage      -> db.store (tables declared in models.TABLES)
  * process      -> workflow_engine, running workflows/workflows.json verbatim
  * audit        -> ext_audit.record + the `audit_trail` table
  * routes       -> mounted outside /api/ so the /api/{table} catch-all in
                    main.py can never shadow them
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import kyc_policy as policy
import rbac
import workflow_engine
from db import store
from ext_audit import record as audit_record
from models import TABLES

router = APIRouter()

CASE_TABLE = "cases"


# --------------------------------------------------------------------------
# Seed the named individual accounts the desk decides with (never anonymous).
# --------------------------------------------------------------------------
def _seed_users():
    if store.list("users"):
        return
    for user in policy.SEED_USERS:
        store.insert(
            "users",
            {
                "username": user["username"],
                "full_name": user["full_name"],
                "role": user["role"],
                "created_at": policy.iso(policy.now_utc()),
                "is_active": True,
            },
        )
        rbac.grant(user["username"], user["role"])


_seed_users()


def user_record(username):
    key = (username or "").strip().lower()
    for row in store.list("users"):
        if row["username"].lower() == key:
            return row
    return None


def role_of(username):
    row = user_record(username)
    return row["role"] if row else None


# --------------------------------------------------------------------------
# Storage helpers — all reads/writes go through db.store
# --------------------------------------------------------------------------
def normalise_reference(reference):
    return (reference or "").strip().lower()


def find_case(reference):
    """Cases are addressed by their submission reference, case-insensitively."""
    key = normalise_reference(reference)
    matches = [c for c in store.list(CASE_TABLE) if c.get("case_reference") == key]
    return matches[-1] if matches else None


def case_by_id(case_id):
    for row in store.list(CASE_TABLE):
        if row["id"] == case_id:
            return row
    return None


def audit(case_id, action_type, performed_by, field_name=None, old_value=None, new_value=None, details=None):
    """Append-only trail: the module log plus the queryable audit_trail table."""
    entry = store.insert(
        "audit_trail",
        {
            "case_id": case_id,
            "action_type": action_type,
            "performed_by_user_id": performed_by,
            "performed_by_role": role_of(performed_by) or "system",
            "timestamp": policy.iso(policy.now_utc()),
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "details": details or {},
        },
    )
    audit_record(f"case.{action_type}", {"case_id": case_id, "by": performed_by, "entry": entry["id"]})
    return entry


def documents_for(case_id):
    return [d for d in store.list("documents") if d["case_id"] == case_id]


def missing_for(case_id):
    return [m["document_type"] for m in store.list("missing_documents") if m["case_id"] == case_id]


# --------------------------------------------------------------------------
# Workflow handlers — the implementation contract of workflows.json
# --------------------------------------------------------------------------
def open_case_from_submission(context):
    submission = context.get("inputs") or {}
    now = policy.iso(policy.now_utc())
    versions = policy.policy_versions()
    row = store.insert(
        CASE_TABLE,
        {
            "case_reference": normalise_reference(submission.get("client_reference")),
            "client_reference": submission.get("client_reference"),
            "client_name": submission.get("client_name"),
            "client_name_normalized": (submission.get("client_name") or "").lower(),
            "entity_type": (submission.get("entity_type") or "corporate").lower(),
            "submitted_by": submission.get("submitted_by"),
            "submitted_documents": list(submission.get("documents") or []),
            "attributes": dict(submission.get("attributes") or {}),
            "risk_factors": dict(submission.get("risk_factors") or {}),
            "status": "open",
            "created_at": now,
            "case_ready_timestamp": None,
            "completeness_passed_at": None,
            "returned_at": None,
            "sla_breached": False,
            "is_at_risk": False,
            "assigned_approver_id": None,
            "next_review_due_date": None,
            "document_checklist_version": versions["document_checklist_version"],
            "risk_matrix_version": versions["risk_matrix_version"],
            "onboarding_policy_version": versions["onboarding_policy_version"],
        },
    )
    entry = audit(
        row["id"],
        "case_opened",
        submission.get("submitted_by"),
        field_name="status",
        old_value=None,
        new_value="open",
        details={"case_reference": row["case_reference"]},
    )
    return {
        "case_id": row["id"],
        "case_reference": row["case_reference"],
        "client_name": row["client_name"],
        "status": row["status"],
        "created_at": row["created_at"],
        "document_checklist_version": row["document_checklist_version"],
        "risk_matrix_version": row["risk_matrix_version"],
        "onboarding_policy_version": row["onboarding_policy_version"],
        "audit_entry_id": entry["id"],
    }


def run_document_completeness_check(context):
    opened = context.get("open_case") or {}
    row = case_by_id(opened.get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("completeness check: case not found")
    result = policy.evaluate_completeness(
        row.get("entity_type"), row.get("submitted_documents"), row.get("attributes"), row.get("risk_factors")
    )
    now = policy.iso(policy.now_utc())
    for item in result["items"]:
        store.insert(
            "documents",
            {
                "case_id": row["id"],
                "document_type": item["document_type"],
                "required": item["required"],
                "conditionally_required": item["conditionally_required"],
                "condition_trigger": item["condition_trigger"],
                "received": item["received"],
                "received_at": now if item["received"] else None,
            },
        )
    for doc in result["missing_documents"]:
        store.insert("missing_documents", {"case_id": row["id"], "document_type": doc, "recorded_at": now})
    audit(
        row["id"],
        "completeness_checked",
        "completeness-check",
        field_name="is_complete",
        old_value=None,
        new_value=result["is_complete"],
        details={
            "missing_documents": result["missing_documents"],
            "document_checklist_version": result["document_checklist_version"],
        },
    )
    return {
        "case_id": row["id"],
        "is_complete": result["is_complete"],
        "required_document_types": result["required_document_types"],
        "received_document_types": result["received_document_types"],
        "missing_documents": result["missing_documents"],
        "conditional_triggers_applied": result["conditional_triggers_applied"],
        "document_checklist_version": result["document_checklist_version"],
    }


def mark_case_ready(context):
    row = case_by_id((context.get("open_case") or {}).get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("mark ready: case not found")
    now = policy.iso(policy.now_utc())
    previous = row["status"]
    row["status"] = "ready"
    row["case_ready_timestamp"] = now
    row["completeness_passed_at"] = now
    entry = audit(
        row["id"], "case_ready", "completeness-check", field_name="status", old_value=previous, new_value="ready"
    )
    return {
        "case_id": row["id"],
        "status": row["status"],
        "case_ready_timestamp": row["case_ready_timestamp"],
        "completeness_passed_at": row["completeness_passed_at"],
        "audit_entry_id": entry["id"],
    }


def compute_risk_score_from_matrix(context):
    row = case_by_id((context.get("open_case") or {}).get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("scoring: case not found")
    scored = policy.score_factors(row.get("risk_factors"))
    now = policy.iso(policy.now_utc())
    factors = row.get("risk_factors") or {}
    score_row = store.insert(
        "risk_scores",
        {
            "case_id": row["id"],
            "jurisdiction_raw_input": factors.get("jurisdiction"),
            "jurisdiction_factor_score": scored["factor_scores"]["jurisdiction"],
            "entity_structure_raw_input": factors.get("entity_structure"),
            "entity_structure_factor_score": scored["factor_scores"]["entity_structure"],
            "industry_raw_input": factors.get("industry"),
            "industry_factor_score": scored["factor_scores"]["industry"],
            "sanctions_screening_raw_input": factors.get("sanctions_screening"),
            "sanctions_screening_factor_score": scored["factor_scores"]["sanctions_screening"],
            "expected_activity_raw_input": factors.get("expected_activity"),
            "expected_activity_factor_score": scored["factor_scores"]["expected_activity"],
            "total_risk_score": scored["total_risk_score"],
            "risk_band": scored["risk_band"],
            "sanctions_true_positive_override_applied": scored["sanctions_true_positive_override_applied"],
            "computed_at": now,
            "factor_weights": scored["factor_weights"],
            "factor_contributions": scored["factor_contributions"],
            "factor_breakdown": scored["factor_breakdown"],
            "risk_matrix_version": scored["risk_matrix_version"],
        },
    )
    row["total_risk_score"] = scored["total_risk_score"]
    row["risk_band"] = scored["risk_band"]
    row["required_approver_role"] = scored["required_approver_role"]
    entry = audit(
        row["id"],
        "risk_scored",
        "risk-matrix-engine",
        field_name="total_risk_score",
        old_value=None,
        new_value=scored["total_risk_score"],
        details={"risk_band": scored["risk_band"], "risk_matrix_version": scored["risk_matrix_version"]},
    )
    return {
        "case_id": row["id"],
        "risk_score_id": score_row["id"],
        "factor_inputs": scored["factor_inputs"],
        "factor_scores": scored["factor_scores"],
        "factor_weights": scored["factor_weights"],
        "factor_contributions": scored["factor_contributions"],
        "factor_breakdown": scored["factor_breakdown"],
        "total_risk_score": scored["total_risk_score"],
        "risk_band": scored["risk_band"],
        "sanctions_true_positive_override_applied": scored["sanctions_true_positive_override_applied"],
        "risk_matrix_version": scored["risk_matrix_version"],
        "computed_at": now,
        "audit_entry_id": entry["id"],
    }


def start_sla_clock(context):
    row = case_by_id((context.get("open_case") or {}).get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("sla: case not found")
    band = row.get("risk_band") or "medium"
    hours = policy.sla_hours_for(band)
    start = policy.now_utc()
    due = policy.add_business_hours(start, hours)
    approver = policy.APPROVER_BY_BAND.get(band, "cora.compliance")
    tracking = store.insert(
        "sla_tracking",
        {
            "case_id": row["id"],
            "sla_start_timestamp": policy.iso(start),
            "sla_due_timestamp": policy.iso(due),
            "risk_band": band,
            "sla_hours": hours,
            "flagged_at_risk_at": None,
            "breached_at": None,
            "breached": False,
        },
    )
    row["sla_start_timestamp"] = policy.iso(start)
    row["sla_due_timestamp"] = policy.iso(due)
    row["sla_hours"] = hours
    row["assigned_approver_id"] = approver
    entry = audit(
        row["id"],
        "sla_started",
        "sla-evaluator",
        field_name="sla_due_timestamp",
        old_value=None,
        new_value=row["sla_due_timestamp"],
        details={"risk_band": band, "sla_hours": hours},
    )
    return {
        "case_id": row["id"],
        "sla_tracking_id": tracking["id"],
        "sla_start_timestamp": row["sla_start_timestamp"],
        "sla_due_timestamp": row["sla_due_timestamp"],
        "sla_hours": hours,
        "risk_band": band,
        "required_approver_role": policy.required_approver_role(band),
        "assigned_approver_id": approver,
        "business_hours_config": dict(policy.BUSINESS_HOURS),
        "audit_entry_id": entry["id"],
    }


def return_case_with_missing_documents(context):
    row = case_by_id((context.get("open_case") or {}).get("case_id"))
    check = context.get("completeness_check") or {}
    if row is None:
        raise workflow_engine.WorkflowError("return: case not found")
    now = policy.iso(policy.now_utc())
    previous = row["status"]
    row["status"] = "returned"
    row["returned_at"] = now
    missing = check.get("missing_documents") or []
    notification = store.insert(
        "notifications",
        {
            "case_id": row["id"],
            "notification_type": "case_returned",
            "recipient_user_id": row.get("submitted_by") or "ana.analyst",
            "sent_at": now,
            "message": "Case "
            + str(row["case_reference"])
            + " returned — missing documents: "
            + (", ".join(missing) or "none"),
            "read_at": None,
        },
    )
    entry = audit(
        row["id"],
        "case_returned",
        "completeness-check",
        field_name="status",
        old_value=previous,
        new_value="returned",
        details={"missing_documents": missing},
    )
    return {
        "case_id": row["id"],
        "status": row["status"],
        "missing_documents": missing,
        "returned_at": now,
        "notification_id": notification["id"],
        "audit_entry_id": entry["id"],
    }


for _name, _fn in [
    ("open_case_from_submission", open_case_from_submission),
    ("run_document_completeness_check", run_document_completeness_check),
    ("mark_case_ready", mark_case_ready),
    ("compute_risk_score_from_matrix", compute_risk_score_from_matrix),
    ("start_sla_clock", start_sla_clock),
    ("return_case_with_missing_documents", return_case_with_missing_documents),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# Case projection served by the API
# --------------------------------------------------------------------------
def case_summary(row):
    return {
        "case_id": row["id"],
        "case_reference": row.get("case_reference"),
        "client_reference": row.get("client_reference"),
        "client_name": row.get("client_name"),
        "client_name_normalized": row.get("client_name_normalized"),
        "entity_type": row.get("entity_type"),
        "status": row.get("status"),
        "submitted_by": row.get("submitted_by"),
        "created_at": row.get("created_at"),
        "case_ready_timestamp": row.get("case_ready_timestamp"),
        "completeness_passed_at": row.get("completeness_passed_at"),
        "returned_at": row.get("returned_at"),
        "missing_documents": missing_for(row["id"]),
        "total_risk_score": row.get("total_risk_score"),
        "risk_band": row.get("risk_band"),
        "required_approver_role": row.get("required_approver_role"),
        "assigned_approver_id": row.get("assigned_approver_id"),
        "sla_due_timestamp": row.get("sla_due_timestamp"),
        "sla_hours": row.get("sla_hours"),
        "is_at_risk": bool(row.get("is_at_risk")),
        "sla_breached": bool(row.get("sla_breached")),
        "next_review_due_date": row.get("next_review_due_date"),
        "document_checklist_version": row.get("document_checklist_version"),
        "risk_matrix_version": row.get("risk_matrix_version"),
        "onboarding_policy_version": row.get("onboarding_policy_version"),
    }


def case_detail(row):
    detail = case_summary(row)
    detail.update(
        {
            "attributes": row.get("attributes") or {},
            "risk_factors": row.get("risk_factors") or {},
            "submitted_documents": row.get("submitted_documents") or [],
            "checklist": [
                {
                    "document_type": d["document_type"],
                    "required": d["required"],
                    "conditionally_required": d["conditionally_required"],
                    "condition_trigger": d["condition_trigger"],
                    "received": d["received"],
                }
                for d in documents_for(row["id"])
            ],
            "waivable": False,
        }
    )
    return detail


# --------------------------------------------------------------------------
# Endpoints (registered outside /api/ — never shadowed by the catch-all)
# --------------------------------------------------------------------------
class CaseSubmission(BaseModel):
    client_reference: str
    client_name: str = ""
    entity_type: str = "corporate"
    submitted_by: str = ""
    documents: list[str] = Field(default_factory=list)
    attributes: dict = Field(default_factory=dict)
    risk_factors: dict = Field(default_factory=dict)


class WaiveRequest(BaseModel):
    document_type: str = ""
    acting_user: str = ""
    reason: str = ""


@router.get("/checklist")
def get_checklist(entity_type: str = "corporate"):
    """The versioned Document Checklist every submission is judged against."""
    return checklist_definition_payload(entity_type)


def checklist_definition_payload(entity_type="corporate"):
    definition = policy.checklist_definition(entity_type)
    definition["all_document_types"] = [i["document_type"] for i in definition["always_required"]] + [
        i["document_type"] for i in definition["conditionally_required"]
    ]
    return definition


@router.post("/cases")
def open_case(submission: CaseSubmission):
    """Open a case and run the approved case-intake workflow end to end."""
    if not normalise_reference(submission.client_reference):
        raise HTTPException(status_code=400, detail="client_reference is required")
    run_id = workflow_engine.start("case-intake-and-risk-scoring", submission.model_dump())
    state = workflow_engine.state(run_id)
    if state.get("status") == "failed":
        raise HTTPException(status_code=500, detail=f"case intake failed: {state.get('error')}")
    row = find_case(submission.client_reference)
    if row is None:
        raise HTTPException(status_code=500, detail="case intake did not open a case")
    payload = case_detail(row)
    payload["workflow_run_id"] = run_id
    payload["workflow_status"] = state.get("status")
    payload["conditional_triggers_applied"] = (state["context"].get("completeness_check") or {}).get(
        "conditional_triggers_applied", []
    )
    payload["required_document_types"] = (state["context"].get("completeness_check") or {}).get(
        "required_document_types", []
    )
    return payload


@router.get("/cases")
def list_cases(status: str | None = None):
    rows = store.list(CASE_TABLE)
    if status:
        rows = [r for r in rows if str(r.get("status")) == status.lower()]
    return {"cases": [case_summary(r) for r in rows], "count": len(rows)}


@router.get("/cases/{reference}")
def get_case(reference: str):
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    return case_detail(row)


@router.post("/cases/{reference}/waive-document")
def waive_document(reference: str, req: WaiveRequest):
    """Never permitted — a required item cannot be waived by any role."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    audit(
        row["id"],
        "waiver_refused",
        req.acting_user or "unknown",
        field_name="document_type",
        old_value=req.document_type,
        new_value="refused",
        details={"reason": "required documents are not waivable"},
    )
    raise HTTPException(
        status_code=403,
        detail=(
            "Required documents cannot be waived by any role, including a compliance_officer. "
            "Only a compliance_officer may record a documented policy exception against the case."
        ),
    )


@router.get("/case-tables")
def case_tables():
    """Which generated tables this slice writes through — transparency aid."""
    return {"tables": sorted(t for t in TABLES if store.list(t))}
