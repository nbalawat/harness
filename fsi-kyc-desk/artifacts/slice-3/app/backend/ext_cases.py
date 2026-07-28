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
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import kyc_policy as policy
import rbac
import workflow_engine
from db import store
from ext_audit import record as audit_record

router = APIRouter()

CASE_TABLE = "cases"

# The approved roster, keyed by lowercased username. This — not the `users`
# table — is the authority on who holds which role, because `users` is in
# models.TABLES and so is writable through main.py's generic /api/{table}
# catch-all. A new decision-maker is added in kyc_policy.SEED_USERS.
APPROVED_ROSTER = {u["username"].strip().lower(): u for u in policy.SEED_USERS}

# Non-human actors: the deterministic steps of the intake workflow, plus
# (slice 3) the drafting agent's own persistence step. Kept distinct from an
# unroled human claim so the trail never reads a person's action as the
# machine's.
MACHINE_ACTORS = {"completeness-check", "risk-matrix-engine", "sla-evaluator", "risk-memo-assistant"}


# --------------------------------------------------------------------------
# Seed the named individual accounts the desk decides with (never anonymous).
# --------------------------------------------------------------------------
def _seed_users():
    existing = {u["username"].lower() for u in store.list("users")}
    for user in policy.SEED_USERS:
        if user["username"].lower() not in existing:
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
    sync_rbac()


def sync_rbac():
    """rbac is the single authority for role checks — keep it fed from `users`.

    Only accounts on the approved roster (`policy.SEED_USERS`) are granted.
    `users` is in `models.TABLES`, so the generic `POST /api/{table}` catch-all
    in main.py can insert an arbitrary row; without this filter anyone could
    self-grant `compliance_officer` and walk straight through the tier checks
    slice 4 enforces via `rbac.require`. A new decision-maker is added to the
    roster in kyc_policy.py, never by posting a row.
    """
    for row in store.list("users"):
        entry = APPROVED_ROSTER.get((row.get("username") or "").strip().lower())
        if entry:
            # Grant the CANONICAL roster spelling, never the row-supplied one —
            # otherwise a posted `{"username": "Cora.Compliance"}` would still
            # let user-controlled data choose the key a grant is stored under.
            rbac.grant(entry["username"], entry["role"])


_seed_users()


def canonical_username(username):
    """The roster's own spelling of a name, or None if it is not on the roster.

    `rbac` grants and looks up by exact string (rbac.has_role / rbac.require),
    so anything that resolves a claimed name MUST canonicalise it first or the
    audit trail and the enforcer will disagree about the same person — e.g.
    "Cora.Compliance" reading as compliance_officer on the trail while
    `rbac.require` refuses it. Slice 4: call this before `rbac.require`.
    """
    entry = APPROVED_ROSTER.get((username or "").strip().lower())
    return entry["username"] if entry else None


def role_of(username):
    """The role the roster records for this person, or None.

    The roster (kyc_policy.SEED_USERS), not the `users` table, is the authority:
    `users` is in models.TABLES and therefore writable through main.py's generic
    /api/{table} catch-all, so a row there is a claim, not evidence of a role.
    rbac is not consulted either — `roles_of` returns roles sorted alphabetically
    and would resolve a multi-grant user to the wrong one.
    """
    entry = APPROVED_ROSTER.get((username or "").strip().lower())
    return entry["role"] if entry else None


def machine_or_unroled(performed_by):
    """Role recorded when the actor holds no roster role.

    A deterministic workflow step is `system`. A human name that is not on the
    roster is `unroled` — never `system`, because REQ-089 asks the trail to say
    who did it, and reading a person's claim back as the machine's own action
    would lose exactly that distinction.
    """
    return "system" if (performed_by or "").strip().lower() in MACHINE_ACTORS else "unroled"


def acting_user(authorization, claimed):
    """Identity is the authenticated caller when auth-basic carries one.

    A body-supplied name is only a claim: it is accepted (the desk is not yet
    behind a login in this slice) but never allowed to override a real session.
    """
    from ext_auth import current_user

    who = (current_user(authorization) or (claimed or "")).strip()
    # Guard the RESOLVED identity, not just the body claim: ext_auth issues a
    # session token for any username, so checking only the claim would let a
    # caller log in AS a workflow step and have their act recorded role
    # "system" — a human action read back as the machine's own.
    if who.lower() in MACHINE_ACTORS:
        raise HTTPException(status_code=400, detail=f"'{who}' is a system actor, not a person")
    # Record the roster's canonical spelling so one person's actions cannot
    # split across "Ana.Analyst"/"ana.analyst" on the trail, and so the name
    # on the trail is the same exact string rbac grants under.
    return canonical_username(who) or who or None


# --------------------------------------------------------------------------
# Storage helpers — all reads/writes go through db.store
# --------------------------------------------------------------------------
def normalise_reference(reference):
    return (reference or "").strip().lower()


def find_case(reference):
    """Cases are addressed by their submission reference, case-insensitively.

    One reference is one case for the life of the relationship: a resubmitted
    package opens a new *cycle* on the same case id, so the audit trail, memo
    versions and decision records of a reference never fragment.
    """
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
            "performed_by_role": role_of(performed_by) or machine_or_unroled(performed_by),
            "timestamp": policy.iso(policy.now_utc()),
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "details": details or {},
        },
    )
    audit_record(f"case.{action_type}", {"case_id": case_id, "by": performed_by, "entry": entry["id"]})
    return entry


def _cycle_of(case_id):
    row = case_by_id(case_id)
    return (row or {}).get("cycle", 1)


def cycle_row(case_id, cycle=None):
    """The per-cycle snapshot — what the case looked like at that submission."""
    if cycle is None:
        cycle = _cycle_of(case_id)
    for row in store.list("case_cycles"):
        if row["case_id"] == case_id and row["cycle"] == cycle:
            return row
    return None


def stamp_cycle(case_id, **fields):
    """Record an outcome on the CURRENT cycle's snapshot.

    Later slices must call this whenever they change what a cycle ended as —
    in particular slice 4 on a decision (decision / decided_at /
    decided_by_user_id / decided_by_role) — or `/cases/{ref}/reproduction`
    will reproduce a decided-then-resubmitted cycle with a stale outcome.
    """
    row = cycle_row(case_id)
    if row is not None:
        row.update(fields)
    return row


def cycles_for(case_id):
    return sorted(
        (c for c in store.list("case_cycles") if c["case_id"] == case_id), key=lambda c: c["cycle"]
    )


def documents_for(case_id):
    """Only the current submission cycle's checklist — earlier cycles are kept."""
    cycle = _cycle_of(case_id)
    return [d for d in store.list("documents") if d["case_id"] == case_id and d.get("cycle", 1) == cycle]


def missing_for(case_id):
    cycle = _cycle_of(case_id)
    return [
        m["document_type"]
        for m in store.list("missing_documents")
        if m["case_id"] == case_id and m.get("cycle", 1) == cycle
    ]


# --------------------------------------------------------------------------
# Workflow handlers — the implementation contract of workflows.json
# --------------------------------------------------------------------------
def open_case_from_submission(context):
    submission = context.get("inputs") or {}
    now = policy.iso(policy.now_utc())
    versions = policy.policy_versions()
    reference = normalise_reference(submission.get("client_reference"))
    submitted_by = submission.get("submitted_by")
    package = {
        "client_reference": submission.get("client_reference"),
        "client_name": submission.get("client_name"),
        "client_name_normalized": (submission.get("client_name") or "").lower(),
        "entity_type": (submission.get("entity_type") or "corporate").lower(),
        "submitted_by": submitted_by,
        "submitted_documents": list(submission.get("documents") or []),
        "attributes": dict(submission.get("attributes") or {}),
        "risk_factors": dict(submission.get("risk_factors") or {}),
        "status": "open",
        "case_ready_timestamp": None,
        "completeness_passed_at": None,
        "returned_at": None,
        "is_at_risk": False,
        "assigned_approver_id": None,
        # A new cycle carries no score and no live clock until this cycle's
        # package passes completeness and is scored again. `sla_breached` is
        # deliberately absent: a recorded breach is permanent (REQ-053).
        "total_risk_score": None,
        "risk_band": None,
        "required_approver_role": None,
        "sla_start_timestamp": None,
        "sla_due_timestamp": None,
        "sla_hours": None,
        "next_review_due_date": None,
        "document_checklist_version": versions["document_checklist_version"],
        "risk_matrix_version": versions["risk_matrix_version"],
        "onboarding_policy_version": versions["onboarding_policy_version"],
    }
    previous = find_case(reference)
    if previous is not None:
        # A resubmission is a new CYCLE of the same case, not a new case: the
        # reference keeps one case id, so its audit trail, memo versions and
        # decision records stay whole. Prior decisions are never rewritten and
        # a recorded SLA breach is permanent — neither is touched here.
        was = previous.get("status")
        row = previous
        row.update(package)
        row["cycle"] = (previous.get("cycle") or 1) + 1
        entry = audit(
            row["id"],
            "case_resubmitted",
            submitted_by,
            field_name="status",
            old_value=was,
            new_value="open",
            details={"cycle": row["cycle"], "case_reference": reference, "previous_cycle_outcome": was},
        )
    else:
        row = store.insert(
            CASE_TABLE, dict(package, case_reference=reference, created_at=now, cycle=1, sla_breached=False)
        )
        entry = audit(
            row["id"],
            "case_opened",
            submitted_by,
            field_name="status",
            old_value=None,
            new_value="open",
            details={"case_reference": row["case_reference"], "cycle": 1},
        )
    # Snapshot what applied at THIS cycle. Later cycles get their own row, so a
    # policy revision or a rescore never retroactively alters an earlier one.
    store.insert(
        "case_cycles",
        {
            "case_id": row["id"],
            "case_reference": row["case_reference"],
            "cycle": row["cycle"],
            "opened_at": now,
            "submitted_by": submitted_by,
            "submitted_documents": list(row.get("submitted_documents") or []),
            "attributes": dict(row.get("attributes") or {}),
            "risk_factors": dict(row.get("risk_factors") or {}),
            "status": "open",
            "missing_documents": [],
            "total_risk_score": None,
            "risk_band": None,
            "case_ready_timestamp": None,
            "returned_at": None,
            # Filled by slice 4 via stamp_cycle() when a human decides this
            # cycle — without it a reproduced past cycle reports the wrong
            # outcome for exactly the cases that were decided then resubmitted.
            "decision": None,
            "decided_at": None,
            "decided_by_user_id": None,
            "decided_by_role": None,
            "document_checklist_version": versions["document_checklist_version"],
            "risk_matrix_version": versions["risk_matrix_version"],
            "onboarding_policy_version": versions["onboarding_policy_version"],
        },
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
    cycle = row.get("cycle", 1)
    for item in result["items"]:
        store.insert(
            "documents",
            {
                "case_id": row["id"],
                "cycle": cycle,
                "document_type": item["document_type"],
                "required": item["required"],
                "conditionally_required": item["conditionally_required"],
                "condition_trigger": item["condition_trigger"],
                "received": item["received"],
                "received_at": now if item["received"] else None,
            },
        )
    for doc in result["missing_documents"]:
        store.insert(
            "missing_documents", {"case_id": row["id"], "cycle": cycle, "document_type": doc, "recorded_at": now}
        )
    stamp_cycle(row["id"], missing_documents=list(result["missing_documents"]))
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
    stamp_cycle(row["id"], status="ready", case_ready_timestamp=now)
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
            "cycle": row.get("cycle", 1),
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
    stamp_cycle(row["id"], total_risk_score=scored["total_risk_score"], risk_band=scored["risk_band"])
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
            "cycle": row.get("cycle", 1),
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
    stamp_cycle(row["id"], status="returned", returned_at=now)
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
        "cycle": row.get("cycle", 1),
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
            # Every submission cycle this reference has been through, each with
            # the policy versions and outcome that applied at the time.
            "cycles": cycles_for(row["id"]),
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
def open_case(submission: CaseSubmission, authorization: str | None = Header(default=None)):
    """Open a case and run the approved case-intake workflow end to end."""
    if not normalise_reference(submission.client_reference):
        raise HTTPException(status_code=400, detail="client_reference is required")
    payload_in = submission.model_dump()
    payload_in["submitted_by"] = acting_user(authorization, submission.submitted_by) or "unknown"
    run_id = workflow_engine.start("case-intake-and-risk-scoring", payload_in)
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
def waive_document(reference: str, req: WaiveRequest, authorization: str | None = Header(default=None)):
    """Never permitted — a required item cannot be waived by any role."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    audit(
        row["id"],
        "waiver_refused",
        acting_user(authorization, req.acting_user) or "unknown",
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
