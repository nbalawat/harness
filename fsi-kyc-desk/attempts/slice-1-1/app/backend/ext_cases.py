"""case-intake-and-completeness slice.

Registers the deterministic handlers for the first half of the
'case-intake-and-risk-scoring' workflow (workflows/workflows.json):
open_case -> completeness_check -> completeness_gate -> mark_ready
                                                      \\-> incomplete_branch -> return_case

POST /cases starts that workflow run and lets workflow_engine drive it —
this module never re-implements the process as ad-hoc endpoint code. Later
slices register 'compute_risk_score_from_matrix' and 'start_sla_clock' on the
SAME workflow definition; until they do, the run simply stops after this
slice's nodes (an expected, harmless 'no handler registered' failure for the
nodes this slice doesn't own) — the case row already carries this slice's
result by the time the run gets there, which is all POST /cases reports.

No analyst can waive a required Document Checklist item (REQ-005): the only
mechanism module-wide that can excuse a required document is a documented,
compliance-officer-granted policy exception recorded elsewhere.
"""
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import workflow_engine
from case_state import machine as case_machine
from db import store
from document_checklist import ALL_ITEMS, CONDITIONAL, describe as describe_checklist, resolve_required
from ext_audit import record as system_audit
from policy_versions import DOCUMENT_CHECKLIST_VERSION, ONBOARDING_POLICY_VERSION, RISK_MATRIX_VERSION

router = APIRouter()


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _get_case_by_id(case_id):
    for row in store.list("cases"):
        if row["id"] == case_id:
            return row
    raise KeyError(f"no case with id {case_id}")


def _find_case_by_ref(reference):
    ref = (reference or "").strip().lower()
    for row in store.list("cases"):
        if row.get("case_reference") == ref:
            return row
    return None


def _audit(case_id, action_type, performed_by_user_id=None, performed_by_role=None,
           field_name=None, old_value=None, new_value=None, details=None):
    """Domain audit_trail row (approved data model) + the generic system trail."""
    row = store.insert(
        "audit_trail",
        {
            "case_id": case_id,
            "action_type": action_type,
            "performed_by_user_id": performed_by_user_id,
            "performed_by_role": performed_by_role,
            "timestamp": _now_iso(),
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "details": details or {},
        },
    )
    system_audit(f"case.{action_type}", {"case_id": case_id, "field_name": field_name,
                                          "old_value": old_value, "new_value": new_value})
    return row


# --------------------------------------------------------------------------
# workflow handlers — case-intake-and-risk-scoring
# --------------------------------------------------------------------------

def open_case_from_submission(context):
    inputs = context.get("inputs") or {}
    client_reference = (inputs.get("client_reference") or "").strip()
    if not client_reference:
        raise workflow_engine.WorkflowError("client_reference is required")
    now = _now_iso()
    row = store.insert(
        "cases",
        {
            "case_reference": client_reference.lower(),
            "client_reference_display": client_reference,
            "client_name": inputs.get("client_name"),
            "entity_type": inputs.get("entity_type"),
            "submitted_by": inputs.get("submitted_by"),
            "attributes": inputs.get("attributes") or {},
            "risk_factors": inputs.get("risk_factors") or {},
            "documents_submitted": inputs.get("documents") or [],
            "status": case_machine.initial,
            "created_at": now,
            "case_ready_timestamp": None,
            "completeness_passed_at": None,
            "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
            "risk_matrix_version": RISK_MATRIX_VERSION,
            "onboarding_policy_version": ONBOARDING_POLICY_VERSION,
        },
    )
    entry = _audit(row["id"], "case_opened", field_name="status", old_value=None, new_value=row["status"])
    return {
        "case_id": row["id"],
        "client_name": row["client_name"],
        "status": row["status"],
        "created_at": row["created_at"],
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
        "risk_matrix_version": RISK_MATRIX_VERSION,
        "onboarding_policy_version": ONBOARDING_POLICY_VERSION,
        "audit_entry_id": entry["id"],
    }


def run_document_completeness_check(context):
    case_id = context["open_case"]["case_id"]
    case = _get_case_by_id(case_id)
    attributes = case.get("attributes") or {}
    risk_factors = case.get("risk_factors") or {}
    submitted = set(case.get("documents_submitted") or [])
    required, triggers = resolve_required(attributes, risk_factors)
    missing = sorted(required - submitted)
    is_complete = not missing
    now = _now_iso()
    for doc_type in ALL_ITEMS:
        store.insert(
            "documents",
            {
                "case_id": case_id,
                "document_type": doc_type,
                "required": doc_type in required,
                "conditionally_required": doc_type in CONDITIONAL,
                "condition_trigger": CONDITIONAL.get(doc_type, {}).get("trigger", ""),
                "received": doc_type in submitted,
                "received_at": now if doc_type in submitted else None,
            },
        )
    for doc_type in missing:
        store.insert("missing_documents", {"case_id": case_id, "document_type": doc_type, "recorded_at": now})
    return {
        "case_id": case_id,
        "is_complete": is_complete,
        "required_document_types": sorted(required),
        "received_document_types": sorted(submitted),
        "missing_documents": missing,
        "conditional_triggers_applied": triggers,
        "document_checklist_version": DOCUMENT_CHECKLIST_VERSION,
    }


def mark_case_ready(context):
    case_id = context["open_case"]["case_id"]
    case = _get_case_by_id(case_id)
    now = _now_iso()
    old_status = case["status"]
    case["status"] = case_machine.advance(old_status, "complete")
    case["case_ready_timestamp"] = now
    case["completeness_passed_at"] = now
    entry = _audit(case_id, "case_ready", field_name="status", old_value=old_status, new_value=case["status"])
    return {
        "case_id": case_id,
        "status": case["status"],
        "case_ready_timestamp": now,
        "completeness_passed_at": now,
        "audit_entry_id": entry["id"],
    }


def return_case_with_missing_documents(context):
    case_id = context["open_case"]["case_id"]
    completeness = context["completeness_check"]
    case = _get_case_by_id(case_id)
    now = _now_iso()
    old_status = case["status"]
    case["status"] = case_machine.advance(old_status, "incomplete")
    case["returned_at"] = now
    notification = store.insert(
        "notifications",
        {
            "case_id": case_id,
            "notification_type": "case_returned",
            "recipient_user_id": case.get("submitted_by"),
            "sent_at": now,
            "message": "Case {} returned — missing: {}".format(
                case.get("case_reference"), ", ".join(completeness["missing_documents"])
            ),
            "read_at": None,
        },
    )
    entry = _audit(
        case_id,
        "case_returned",
        field_name="status",
        old_value=old_status,
        new_value=case["status"],
        details={"missing_documents": completeness["missing_documents"]},
    )
    return {
        "case_id": case_id,
        "status": case["status"],
        "missing_documents": completeness["missing_documents"],
        "returned_at": now,
        "notification_id": notification["id"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("open_case_from_submission", open_case_from_submission)
workflow_engine.register_handler("run_document_completeness_check", run_document_completeness_check)
workflow_engine.register_handler("mark_case_ready", mark_case_ready)
workflow_engine.register_handler("return_case_with_missing_documents", return_case_with_missing_documents)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class CaseSubmission(BaseModel):
    client_reference: str
    client_name: str
    entity_type: str
    submitted_by: str
    documents: list[str] = []
    attributes: dict = {}
    risk_factors: dict = {}


class WaiveRequest(BaseModel):
    document_type: str
    acting_user: str


def _case_view(row):
    case_id = row["id"]
    missing = [m["document_type"] for m in store.list("missing_documents") if m["case_id"] == case_id]
    documents = [d for d in store.list("documents") if d["case_id"] == case_id]
    return {
        "id": case_id,
        "case_reference": row["case_reference"],
        "client_reference": row.get("client_reference_display", row["case_reference"]),
        "client_name": row.get("client_name"),
        "entity_type": row.get("entity_type"),
        "submitted_by": row.get("submitted_by"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "case_ready_timestamp": row.get("case_ready_timestamp"),
        "completeness_passed_at": row.get("completeness_passed_at"),
        "returned_at": row.get("returned_at"),
        "document_checklist_version": row.get("document_checklist_version"),
        "risk_matrix_version": row.get("risk_matrix_version"),
        "onboarding_policy_version": row.get("onboarding_policy_version"),
        "attributes": row.get("attributes") or {},
        "risk_factors": row.get("risk_factors") or {},
        "documents_submitted": row.get("documents_submitted") or [],
        "documents": documents,
        "missing_documents": missing,
        "is_at_risk": row.get("is_at_risk", False),
        "sla_breached": row.get("sla_breached", False),
        "sla_due_timestamp": row.get("sla_due_timestamp"),
        "assigned_approver_id": row.get("assigned_approver_id"),
        "next_review_due_date": row.get("next_review_due_date"),
    }


@router.post("/cases")
def create_case(req: CaseSubmission):
    inputs = req.model_dump()
    workflow_engine.start("case-intake-and-risk-scoring", inputs)
    case = _find_case_by_ref(req.client_reference)
    if case is None:
        raise HTTPException(status_code=500, detail="case intake did not produce a case record")
    return _case_view(case)


@router.get("/cases")
def list_cases():
    return [_case_view(r) for r in store.list("cases")]


@router.get("/cases/{reference}")
def get_case(reference: str):
    case = _find_case_by_ref(reference)
    if case is None:
        raise HTTPException(status_code=404, detail=f"no case '{reference}'")
    return _case_view(case)


@router.post("/cases/{reference}/waive-document")
def waive_document(reference: str, req: WaiveRequest):
    case = _find_case_by_ref(reference)
    if case is None:
        raise HTTPException(status_code=404, detail=f"no case '{reference}'")
    raise HTTPException(
        status_code=403,
        detail=(
            f"Required Document Checklist items (here: '{req.document_type}') can never be waived "
            "by an analyst. Only a compliance officer may grant a documented policy exception via "
            f"POST /cases/{reference}/exceptions."
        ),
    )


@router.get("/checklist")
def get_checklist():
    return describe_checklist()
