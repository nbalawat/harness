"""Slice 1 — case intake and the deterministic completeness check.

The business process lives in workflows/workflows.json
("case-intake-and-risk-scoring"); this module registers the deterministic
handlers that definition names and exposes the HTTP surface that starts and
reads it. Routes live outside /api/ so the generic /api/{table} catch-all in
main.py can never shadow them.
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import forms
import kyc_policy as policy
import kyc_store as kyc
import workflow_engine
from db import store

router = APIRouter()

WORKFLOW = "case-intake-and-risk-scoring"

SUBMISSION_SCHEMA = {
    "client_reference": {"type": "str", "required": True, "max_len": 64},
    "client_name": {"type": "str", "required": True, "max_len": 200},
    "entity_type": {"type": "str", "required": False, "max_len": 40},
    "submitted_by": {"type": "str", "required": False, "max_len": 64},
}


# ==========================================================================
# Workflow handlers — the deterministic nodes of case-intake-and-risk-scoring
# ==========================================================================
def _submission(context: dict) -> dict:
    return dict(context.get("inputs") or {})


def open_case_from_submission(context: dict) -> dict:
    """Node open_case: a client submission opens a case (onboarding policy §1)."""
    sub = _submission(context)
    actor = sub.get("submitted_by") or "system"
    case = store.insert(
        kyc.CASES,
        {
            "case_reference": kyc.reference(sub.get("client_reference")),
            "client_reference": sub.get("client_reference"),
            "client_name": sub.get("client_name"),
            "entity_type": sub.get("entity_type") or "corporate",
            "submitted_by": actor,
            "status": "new",
            "created_at": kyc.now(),
            "case_ready_timestamp": None,
            "completeness_passed_at": None,
            "returned_at": None,
            "attributes": sub.get("attributes") or {},
            "risk_factors": sub.get("risk_factors") or {},
            "submitted_documents": sub.get("documents") or [],
            "risk_band": None,
            "total_risk_score": None,
            "assigned_approver_id": None,
            "required_approver_role": None,
            "sla_due_timestamp": None,
            "sla_hours": None,
            "is_at_risk": False,
            "sla_breached": False,
            "next_review_due_date": None,
            **policy.POLICY_VERSIONS,
        },
    )
    entry = kyc.record_audit(
        case["id"],
        "case_opened",
        actor,
        field_name="status",
        old_value=None,
        new_value="new",
        details={"case_reference": case["case_reference"], "client_name": case["client_name"]},
    )
    return {
        "case_id": case["id"],
        "case_reference": case["case_reference"],
        "client_name": case["client_name"],
        "status": case["status"],
        "created_at": case["created_at"],
        "document_checklist_version": policy.DOCUMENT_CHECKLIST_VERSION,
        "risk_matrix_version": policy.RISK_MATRIX_VERSION,
        "onboarding_policy_version": policy.ONBOARDING_POLICY_VERSION,
        "audit_entry_id": entry["id"],
    }


def run_document_completeness_check(context: dict) -> dict:
    """Node completeness_check: mechanical, no judgment, no waivers (checklist v2.0)."""
    case = kyc.case_by_id(context["open_case"]["case_id"])
    result = policy.completeness(case["submitted_documents"], case["attributes"], case["risk_factors"])
    kyc.replace_document_rows(case["id"], result["required_documents"], result["received_document_types"])
    kyc.record_missing(case["id"], result["missing_documents"])
    kyc.record_audit(
        case["id"],
        "completeness_check_run",
        case.get("submitted_by") or "system",
        field_name="completeness",
        old_value=None,
        new_value="pass" if result["is_complete"] else "fail",
        details={
            "required_document_types": result["required_document_types"],
            "missing_documents": result["missing_documents"],
            "document_checklist_version": result["document_checklist_version"],
        },
    )
    return {
        "case_id": case["id"],
        "is_complete": result["is_complete"],
        "required_document_types": result["required_document_types"],
        "received_document_types": result["received_document_types"],
        "missing_documents": result["missing_documents"],
        "conditional_triggers_applied": result["conditional_triggers_applied"],
        "document_checklist_version": result["document_checklist_version"],
    }


def mark_case_ready(context: dict) -> dict:
    """Node mark_ready: a complete package becomes READY with its ready stamp."""
    case = kyc.case_by_id(context["completeness_check"]["case_id"])
    stamp = kyc.now()
    old_status = case["status"]
    kyc.patch_case(
        case,
        {"status": "ready", "case_ready_timestamp": stamp, "completeness_passed_at": stamp},
        case.get("submitted_by") or "system",
    )
    entry = kyc.record_audit(
        case["id"],
        "case_marked_ready",
        case.get("submitted_by") or "system",
        field_name="status",
        old_value=old_status,
        new_value="ready",
        details={"case_ready_timestamp": stamp},
    )
    return {
        "case_id": case["id"],
        "status": case["status"],
        "case_ready_timestamp": stamp,
        "completeness_passed_at": stamp,
        "audit_entry_id": entry["id"],
    }


def compute_risk_score_from_matrix(context: dict) -> dict:
    """Node score_case: weighted-sum scoring from risk rating matrix v2.1."""
    case = kyc.case_by_id(context["mark_ready"]["case_id"])
    computed = policy.score(case["risk_factors"])
    stamp = kyc.now()
    row = store.insert(
        "risk_scores",
        {
            "case_id": case["id"],
            **{f"{f}_factor_score": computed["factor_scores"][f] for f in computed["factor_scores"]},
            **{f"{f}_raw_input": computed["factor_inputs"][f] for f in computed["factor_inputs"]},
            "factor_breakdown": computed["factor_breakdown"],
            "total_risk_score": computed["total_risk_score"],
            "risk_band": computed["risk_band"],
            "computed_risk_band": computed["computed_risk_band"],
            "sanctions_true_positive_override_applied": computed["sanctions_true_positive_override_applied"],
            "risk_matrix_version": policy.RISK_MATRIX_VERSION,
            "computed_at": stamp,
        },
    )
    kyc.patch_case(
        case,
        {
            "total_risk_score": computed["total_risk_score"],
            "risk_band": computed["risk_band"],
            "risk_matrix_version": policy.RISK_MATRIX_VERSION,
            "required_approver_role": policy.required_approver_role(computed["risk_band"]),
        },
        case.get("submitted_by") or "system",
    )
    entry = kyc.record_audit(
        case["id"],
        "risk_score_computed",
        "system",
        field_name="total_risk_score",
        old_value=None,
        new_value=computed["total_risk_score"],
        details={"risk_band": computed["risk_band"], "risk_matrix_version": policy.RISK_MATRIX_VERSION},
        performed_by_role="system",
    )
    return {
        "case_id": case["id"],
        "risk_score_id": row["id"],
        "factor_inputs": computed["factor_inputs"],
        "factor_scores": computed["factor_scores"],
        "factor_weights": computed["factor_weights"],
        "factor_contributions": computed["factor_contributions"],
        "factor_breakdown": computed["factor_breakdown"],
        "total_risk_score": computed["total_risk_score"],
        "risk_band": computed["risk_band"],
        "sanctions_true_positive_override_applied": computed["sanctions_true_positive_override_applied"],
        "risk_matrix_version": policy.RISK_MATRIX_VERSION,
        "computed_at": stamp,
        "audit_entry_id": entry["id"],
    }


def start_sla_clock(context: dict) -> dict:
    """Node start_sla: the band's business-hour clock runs from case-ready (SLA policy v1.4)."""
    case = kyc.case_by_id(context["score_case"]["case_id"])
    band = case["risk_band"]
    hours = policy.sla_hours_for(band)
    start = case["case_ready_timestamp"]
    due = policy.add_business_hours(start, hours)
    approver_role = policy.required_approver_role(band)
    approver = policy.DEFAULT_APPROVER.get(band, "cora.compliance")
    row = store.insert(
        "sla_tracking",
        {
            "case_id": case["id"],
            "sla_start_timestamp": start,
            "sla_due_timestamp": due,
            "risk_band": band,
            "sla_hours": hours,
            "flagged_at_risk_at": None,
            "breached_at": None,
            "breached": False,
        },
    )
    kyc.patch_case(
        case,
        {
            "sla_due_timestamp": due,
            "sla_hours": hours,
            "assigned_approver_id": approver,
            "required_approver_role": approver_role,
        },
        "system",
    )
    entry = kyc.record_audit(
        case["id"],
        "sla_clock_started",
        "system",
        field_name="sla_due_timestamp",
        old_value=None,
        new_value=due,
        details={"sla_hours": hours, "risk_band": band, "assigned_approver_id": approver},
        performed_by_role="system",
    )
    return {
        "case_id": case["id"],
        "sla_tracking_id": row["id"],
        "sla_start_timestamp": start,
        "sla_due_timestamp": due,
        "sla_hours": hours,
        "risk_band": band,
        "required_approver_role": approver_role,
        "assigned_approver_id": approver,
        "business_hours_config": policy.BUSINESS_HOURS,
        "audit_entry_id": entry["id"],
    }


def return_case_with_missing_documents(context: dict) -> dict:
    """Node return_case: incomplete packages are RETURNED, itemised — never parked."""
    check = context["completeness_check"]
    case = kyc.case_by_id(check["case_id"])
    stamp = kyc.now()
    old_status = case["status"]
    kyc.patch_case(case, {"status": "returned", "returned_at": stamp}, case.get("submitted_by") or "system")
    missing = check["missing_documents"]
    note = kyc.notify(
        case["id"],
        "case_returned",
        case.get("submitted_by") or "system",
        "Case "
        + case["case_reference"]
        + " returned: missing "
        + ", ".join(missing)
        + " (document checklist v"
        + policy.DOCUMENT_CHECKLIST_VERSION
        + ").",
        {"case_reference": case["case_reference"], "missing_documents": missing},
    )
    entry = kyc.record_audit(
        case["id"],
        "case_returned",
        case.get("submitted_by") or "system",
        field_name="status",
        old_value=old_status,
        new_value="returned",
        details={"missing_documents": missing, "notification_id": note["id"]},
    )
    return {
        "case_id": case["id"],
        "status": case["status"],
        "missing_documents": missing,
        "returned_at": stamp,
        "notification_id": note["id"],
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


# ==========================================================================
# Views
# ==========================================================================
def case_view(case: dict) -> dict:
    """One shape for a case everywhere it is served."""
    docs = kyc.documents_for(case["id"])
    return {
        "case_reference": case["case_reference"],
        "case_id": case["id"],
        "client_reference": case.get("client_reference"),
        "client_name": case.get("client_name"),
        "entity_type": case.get("entity_type"),
        "submitted_by": case.get("submitted_by"),
        "status": case.get("status"),
        "created_at": case.get("created_at"),
        "case_ready_timestamp": case.get("case_ready_timestamp"),
        "completeness_passed_at": case.get("completeness_passed_at"),
        "returned_at": case.get("returned_at"),
        "risk_band": case.get("risk_band"),
        "total_risk_score": case.get("total_risk_score"),
        "required_approver_role": case.get("required_approver_role"),
        "assigned_approver_id": case.get("assigned_approver_id"),
        "sla_due_timestamp": case.get("sla_due_timestamp"),
        "sla_hours": case.get("sla_hours"),
        "is_at_risk": bool(case.get("is_at_risk")),
        "sla_breached": bool(case.get("sla_breached")),
        "next_review_due_date": case.get("next_review_due_date"),
        "document_checklist_version": case.get("document_checklist_version"),
        "risk_matrix_version": case.get("risk_matrix_version"),
        "onboarding_policy_version": case.get("onboarding_policy_version"),
        "attributes": case.get("attributes") or {},
        "risk_factors": case.get("risk_factors") or {},
        "missing_documents": kyc.missing_for(case["id"]),
        "documents": [
            {
                "document_type": d["document_type"],
                "title": d.get("title"),
                "required": d.get("required"),
                "conditionally_required": d.get("conditionally_required"),
                "condition_trigger": d.get("condition_trigger"),
                "received": d.get("received"),
            }
            for d in docs
        ],
        "waivable_by_analyst": False,
    }


def _require_case(case_reference):
    case = kyc.find_case(case_reference)
    if case is None:
        raise HTTPException(status_code=404, detail=f"no case '{case_reference}'")
    return case


# ==========================================================================
# Endpoints
# ==========================================================================
class CaseSubmission(BaseModel):
    client_reference: str
    client_name: str
    entity_type: str = "corporate"
    submitted_by: str | None = None
    documents: list = []
    attributes: dict = {}
    risk_factors: dict = {}


@router.get("/checklist")
def get_checklist():
    """The Document Checklist in force — base items and conditional triggers."""
    return policy.checklist()


@router.post("/cases")
def submit_case(req: CaseSubmission, authorization: str | None = Header(default=None)):
    """A client submission opens a case and runs the intake workflow end to end."""
    actor = kyc.resolve_actor(authorization, req.submitted_by)
    checked = forms.validate(
        SUBMISSION_SCHEMA,
        {
            "client_reference": req.client_reference,
            "client_name": req.client_name,
            "entity_type": req.entity_type,
            "submitted_by": actor,
        },
    )
    if not checked["ok"]:
        raise HTTPException(status_code=400, detail="; ".join(checked["errors"]))
    if kyc.find_case(req.client_reference) is not None:
        raise HTTPException(status_code=409, detail=f"case '{kyc.reference(req.client_reference)}' already exists")

    inputs = {
        "client_reference": req.client_reference,
        "client_name": req.client_name,
        "entity_type": req.entity_type,
        "submitted_by": actor,
        "documents": req.documents,
        "attributes": req.attributes,
        "risk_factors": req.risk_factors,
    }
    run_id = workflow_engine.start(WORKFLOW, inputs)
    state = workflow_engine.state(run_id)
    if state.get("status") == "failed":
        raise HTTPException(status_code=500, detail=f"intake workflow failed: {state.get('error')}")

    case = kyc.find_case(req.client_reference)
    if case is None:
        raise HTTPException(status_code=500, detail="intake workflow did not open a case")
    check = state["context"].get("completeness_check", {})
    return {
        **case_view(case),
        "required_document_types": check.get("required_document_types", []),
        "received_document_types": check.get("received_document_types", []),
        "conditional_triggers_applied": check.get("conditional_triggers_applied", []),
        "completeness_passed": bool(check.get("is_complete")),
        "workflow": WORKFLOW,
        "workflow_run_id": run_id,
        "workflow_status": state.get("status"),
    }


@router.get("/cases")
def list_cases(status: str | None = None, risk_band: str | None = None):
    """The worklist: every case with its status and itemised missing documents."""
    rows = [case_view(c) for c in kyc.cases()]
    if status:
        rows = [r for r in rows if r["status"] == kyc.reference(status)]
    if risk_band:
        rows = [r for r in rows if (r["risk_band"] or "") == kyc.reference(risk_band)]
    return rows


@router.get("/cases/{case_reference}")
def get_case(case_reference: str):
    return case_view(_require_case(case_reference))


@router.get("/cases/{case_reference}/documents")
def get_case_documents(case_reference: str):
    case = _require_case(case_reference)
    view = case_view(case)
    return {
        "case_reference": view["case_reference"],
        "document_checklist_version": view["document_checklist_version"],
        "documents": view["documents"],
        "missing_documents": view["missing_documents"],
        "waivable_by_analyst": False,
    }


class WaiveRequest(BaseModel):
    document_type: str
    acting_user: str | None = None
    reason: str | None = None


@router.post("/cases/{case_reference}/waive-document")
def waive_document(case_reference: str, req: WaiveRequest, authorization: str | None = Header(default=None)):
    """Refused by design: completeness is mechanical and no role waives it here.

    Document checklist v2.0 — 'analysts may not waive items. Exceptions require
    a Compliance Officer policy exception, which is itself recorded.'
    """
    case = _require_case(case_reference)
    actor = kyc.resolve_actor(authorization, req.acting_user)
    kyc.record_audit(
        case["id"],
        "document_waiver_refused",
        actor,
        field_name="missing_documents",
        old_value=policy.normalize_document_type(req.document_type),
        new_value=policy.normalize_document_type(req.document_type),
        details={"reason": "completeness is mechanical; no waiver is possible", "requested_by": actor},
    )
    raise HTTPException(
        status_code=403,
        detail=(
            "document requirements cannot be waived: completeness is a mechanical check under document "
            "checklist v" + policy.DOCUMENT_CHECKLIST_VERSION + ". A compliance officer policy exception is "
            "the only recorded route, and it is granted by the compliance_officer role, never by an analyst."
        ),
    )
