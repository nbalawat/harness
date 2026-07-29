"""intake-triage-pipeline slice.

Implements the first three stages of the approved `deal-underwriting`
workflow (workflows/workflows.json): record_intake -> triage_request (agent)
-> persist_triage_draft -> [review_triage: human] -> apply_triage_decision
-> route_to_queue. The four deterministic nodes are registered as real
workflow_engine handlers (the implementation contract), so a caller driving
the full `deal-underwriting` workflow through POST /workflows/deal-underwriting/start
runs this slice's portion end to end and parks correctly at the human
review_triage gate.

The REST surface below (/deals/intake, /deals, /deals/{id}/triage/run,
/deals/{id}/triage/accept) calls those SAME handler functions directly with a
hand-built context, because the acceptance contract needs three separate
human-facing steps (submit -> agent proposes -> analyst accepts, with the
analyst able to confirm/override the queue) rather than the one-shot chain
the generic engine would run. Nothing here re-implements the process; it
drives the same functions the workflow definition names.

Composition contract:
  * storage  -> db.store only (deals, source_artifacts, triage_outputs,
                analyst_queues, user_deal_assignments, audit_trail)
  * files    -> blob_store only — every artifact's raw content is written and
                read back through blob_store, never open()'d from a request
                path
  * process  -> deal_state.machine owns current_stage transitions
  * agent    -> agent_runtime.respond() for the triage narrative; the
                Intake Triage Agent's structured proposal (request_type,
                missing_documents, recommended_queue, ...) is computed
                deterministically from the deal's own stored artifacts and
                the published document checklist, exactly like the
                credit-memo pattern elsewhere in this codebase: the model's
                reply is advisory narrative only, never the source of a
                figure or a routing decision.
  * audit    -> ext_audit.record + the domain audit_trail table
  * routes   -> mounted outside /api/ so the /api/{table} catch-all in
                main.py can never shadow them
"""
import time

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import agent_runtime
import assignment
import blob_store
import rbac
import workflow_engine
from db import store
from deal_state import machine as stage_machine
from deal_documents import resolve_missing as resolve_missing_documents
from ext_audit import record as system_audit
from ext_auth import current_user
from statemachine import IllegalTransition

router = APIRouter()

DEFAULT_QUEUE = "commercial-general-queue"
QUEUE_BY_INDUSTRY = {
    "manufacturing": "commercial-ci-queue",
    "wholesale": "commercial-ci-queue",
    "retail": "commercial-ci-queue",
    "healthcare": "commercial-ci-queue",
    "real_estate": "commercial-re-queue",
    "real estate": "commercial-re-queue",
    "hospitality": "commercial-re-queue",
}
ANALYST_QUEUE_WORKERS = {
    "commercial-ci-queue": ["user-analyst-1"],
    "commercial-re-queue": ["user-analyst-1"],
    "commercial-general-queue": ["user-analyst-1"],
}


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _ensure_queues_seeded():
    existing = {q["queue_name"] for q in store.list("analyst_queues")}
    for queue_name, workers in ANALYST_QUEUE_WORKERS.items():
        if queue_name not in existing:
            store.insert("analyst_queues", {"queue_name": queue_name, "analyst_id": workers[0], "created_at": _now_iso()})


_ensure_queues_seeded()


def _get_deal(deal_id):
    for row in store.list("deals"):
        if row.get("deal_id") == deal_id:
            return row
    return None


def _get_deal_or_404(deal_id):
    deal = _get_deal(deal_id)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    return deal


def _rm_scope(authorization):
    """Row-level scoping (REQ-045, REQ-048): an authenticated relationship
    manager sees only the deals they themselves submitted. Returns the
    scoping user id, or None when no scoping applies (no session at all, or a
    session held by a role granted portfolio-wide read: credit_analyst,
    credit_officer, admin) — every acceptance call in this build
    calls these endpoints with no Authorization header at all, so the
    unscoped, backward-compatible "see everything" behavior every earlier
    slice's acceptance relies on is preserved whenever no session is
    presented."""
    actor = current_user(authorization)
    if actor is None:
        return None
    if rbac.has_role(actor, "credit_analyst") or rbac.has_role(actor, "credit_officer") or rbac.has_role(actor, "admin"):
        # Portfolio-wide read is a granted role, never a default: anyone else
        # holding a session (a relationship manager, or a user with no grants
        # at all) is scoped to the deals they themselves submitted (REQ-048).
        return None
    return actor


def _artifacts_for(deal_id):
    return [a for a in store.list("source_artifacts") if a["deal_id"] == deal_id]


def _artifact_texts(deal_id):
    """artifact_type -> [raw text, ...], read back through blob_store only."""
    texts = {}
    for artifact in _artifacts_for(deal_id):
        try:
            raw = blob_store.get(artifact["file_path"]).decode("utf-8", errors="replace")
        except FileNotFoundError:
            raw = ""
        texts.setdefault(artifact["artifact_type"], []).append(raw)
    return texts


def _latest_triage_output(deal_id):
    rows = [r for r in store.list("triage_outputs") if r["deal_id"] == deal_id]
    return rows[-1] if rows else None


def _get_or_create_queue(queue_name):
    for q in store.list("analyst_queues"):
        if q["queue_name"] == queue_name:
            return q
    workers = ANALYST_QUEUE_WORKERS.get(queue_name, ["user-analyst-1"])
    return store.insert("analyst_queues", {"queue_name": queue_name, "analyst_id": workers[0], "created_at": _now_iso()})


def _assign_owner(queue_name):
    workers = ANALYST_QUEUE_WORKERS.get(queue_name) or ["user-analyst-1"]
    return assignment.round_robin(workers, queue=queue_name)


def _audit(deal_id, event_type, actor_id, actor_type, before=None, after=None, description=""):
    """Domain audit_trail row (approved data model) + the generic system trail."""
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


def _deal_view(row):
    return {
        "deal_id": row["deal_id"],
        "borrower_name": row.get("borrower_name"),
        "industry": row.get("industry"),
        "requested_amount": row.get("requested_amount"),
        "collateral_description": row.get("collateral_description"),
        "ltv_percentage": row.get("ltv_percentage"),
        "current_stage": row.get("current_stage"),
        "assigned_owner_id": row.get("assigned_owner_id"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "last_activity_at": row.get("last_activity_at"),
        "submitted_by_id": row.get("submitted_by_id"),
        "artifact_count": len(_artifacts_for(row["deal_id"])),
    }


def _classify_request(texts):
    email_text = " ".join(texts.get("email", [])).lower()
    combined = " ".join(v for vals in texts.values() for v in vals).lower()
    if "refinance" in email_text or "refinance" in combined:
        request_type = "refinance"
    elif any(k in combined for k in ("expansion", "acquisition", "purchase")):
        request_type = "new_credit_request"
    else:
        request_type = "credit_request"
    if "term loan" in combined:
        product_type = "term_loan"
    elif any(k in combined for k in ("line of credit", "revolver", "revolving")):
        product_type = "revolving_line_of_credit"
    elif "sba" in combined:
        product_type = "sba_loan"
    else:
        product_type = "commercial_loan"
    return request_type, product_type


# --------------------------------------------------------------------------
# workflow handlers — deal-underwriting (this slice's portion)
# --------------------------------------------------------------------------

def record_deal_intake(context):
    inputs = context.get("inputs") or {}
    borrower_name = (inputs.get("borrower_name") or "").strip()
    if not borrower_name:
        raise workflow_engine.WorkflowError("borrower_name is required")
    submitted_by_id = inputs.get("submitted_by_id")
    industry = inputs.get("industry") or "unspecified"
    now = _now_iso()
    seq = len(store.list("deals")) + 1
    deal_id = f"DEAL-{seq:03d}"
    deal_row = store.insert(
        "deals",
        {
            "deal_id": deal_id,
            "borrower_name": borrower_name,
            "industry": industry,
            "requested_amount": inputs.get("requested_amount"),
            "collateral_description": inputs.get("collateral_description") or "",
            "ltv_percentage": inputs.get("ltv_percentage"),
            "current_stage": stage_machine.initial,
            "assigned_owner_id": None,
            "created_at": now,
            "last_activity_at": now,
            "status": "active",
            "submitted_by_id": submitted_by_id,
        },
    )
    artifact_ids = []
    for i, artifact in enumerate(inputs.get("artifacts") or [], start=1):
        blob_name = f"{deal_id}-{i}-{artifact.get('file_name') or 'artifact'}"
        stored_name = blob_store.save(blob_name, (artifact.get("content") or "").encode("utf-8"))
        art_row = store.insert(
            "source_artifacts",
            {
                "deal_id": deal_id,
                "artifact_type": artifact.get("artifact_type"),
                "file_name": artifact.get("file_name"),
                "file_path": stored_name,
                "content_type": artifact.get("content_type"),
                "uploaded_at": now,
                "uploaded_by_id": submitted_by_id,
            },
        )
        artifact_ids.append(art_row["id"])
    _audit(
        deal_id,
        "deal.intake_recorded",
        submitted_by_id,
        "human",
        after={"current_stage": deal_row["current_stage"], "artifact_count": len(artifact_ids)},
        description=f"Deal submitted by {submitted_by_id} with {len(artifact_ids)} artifact(s).",
    )
    return {
        "deal_id": deal_id,
        "borrower_name": borrower_name,
        "industry": industry,
        "requested_amount": deal_row["requested_amount"],
        "ltv_percentage": deal_row["ltv_percentage"],
        "stored_artifact_ids": artifact_ids,
        "current_stage": deal_row["current_stage"],
    }


def persist_triage_draft(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to triage")
    texts = _artifact_texts(deal_id)
    present_types = set(texts.keys())
    request_type, product_type = _classify_request(texts)
    missing_documents, covered = resolve_missing_documents(present_types)
    has_financials = bool(texts.get("spreadsheet")) or bool(texts.get("financial_statement"))
    underwriting_suitable = bool(deal.get("requested_amount")) and has_financials
    recommended_queue = QUEUE_BY_INDUSTRY.get((deal.get("industry") or "").lower(), DEFAULT_QUEUE)
    artifact_ids = record.get("stored_artifact_ids") or [a["id"] for a in _artifacts_for(deal_id)]
    agent_reply = (context.get("triage_request") or {}).get("reply", "")
    rationale = (
        f"Classified from stored artifact(s) {artifact_ids}: request type '{request_type}', product "
        f"'{product_type}'. "
        + ("Financial statements are on file." if has_financials else "No financial statements are on file yet.")
        + (f" Missing: {', '.join(missing_documents)}." if missing_documents else " Document checklist is complete.")
        + f" Agent notes: {agent_reply}"
    )
    now = _now_iso()
    row = store.insert(
        "triage_outputs",
        {
            "deal_id": deal_id,
            "request_type": request_type,
            "product_type": product_type,
            "underwriting_suitable": underwriting_suitable,
            "missing_documents": missing_documents,
            "recommended_queue": recommended_queue,
            "draft_status": "pending",
            "created_at": now,
            "accepted_at": None,
            "accepted_by_id": None,
        },
    )
    entry = _audit(
        deal_id,
        "triage.drafted",
        "intake-triage-agent",
        "agent",
        after={"draft_status": "pending", "recommended_queue": recommended_queue},
        description=rationale,
    )
    return {
        "triage_output_id": row["id"],
        "deal_id": deal_id,
        "draft_status": "pending",
        "request_type": request_type,
        "product_type": product_type,
        "underwriting_suitable": underwriting_suitable,
        "missing_documents": missing_documents,
        "recommended_queue": recommended_queue,
        "rationale": rationale,
        "audit_entry_id": entry["id"],
    }


def apply_triage_review_decision(context):
    record = context.get("record_intake") or {}
    draft = context.get("persist_triage_draft") or {}
    deal_id = record.get("deal_id") or draft.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to decide triage for")
    decision_details = context.get("decision_details") or {}
    if decision_details:
        decision = (decision_details.get("decision") or "accept").lower()
        accepted_by_id = decision_details.get("accepted_by_id")
        accepted_queue = decision_details.get("accepted_queue") or draft.get("recommended_queue")
    else:
        review = context.get("review_triage") or {}
        decision = "accept" if review.get("approved") else "return_for_rework"
        accepted_by_id = review.get("by")
        accepted_queue = draft.get("recommended_queue")
    status = "accepted" if decision == "accept" else "returned_for_rework"
    now = _now_iso()
    triage_row = _latest_triage_output(deal_id)
    if triage_row is not None:
        before_status = triage_row["draft_status"]
        triage_row["draft_status"] = status
        triage_row["accepted_by_id"] = accepted_by_id
        if status == "accepted":
            triage_row["accepted_at"] = now
            triage_row["recommended_queue"] = accepted_queue
        _audit(
            deal_id,
            f"triage.{status}",
            accepted_by_id,
            "human",
            before={"draft_status": before_status},
            after={"draft_status": status, "queue": accepted_queue},
            description=f"Triage proposal {status} by {accepted_by_id}.",
        )
    return {
        "deal_id": deal_id,
        "triage_status": status,
        "accepted_queue": accepted_queue,
        "accepted_by_id": accepted_by_id,
        "accepted_at": now,
    }


def route_deal_to_analyst_queue(context):
    decision = context.get("apply_triage_decision") or {}
    deal_id = decision.get("deal_id") or (context.get("record_intake") or {}).get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to route")
    queue_name = decision.get("accepted_queue") or DEFAULT_QUEUE
    queue_row = _get_or_create_queue(queue_name)
    owner_id = _assign_owner(queue_name)
    previous_stage = deal["current_stage"]
    try:
        new_stage = stage_machine.advance(previous_stage, "accept_triage")
    except IllegalTransition as e:
        raise workflow_engine.WorkflowError(str(e))
    now = _now_iso()
    deal["current_stage"] = new_stage
    deal["assigned_owner_id"] = owner_id
    deal["last_activity_at"] = now
    store.insert(
        "user_deal_assignments",
        {"user_id": owner_id, "deal_id": deal_id, "assignment_type": "owner", "created_at": now},
    )
    _audit(
        deal_id,
        "deal.routed",
        decision.get("accepted_by_id"),
        "human",
        before={"current_stage": previous_stage},
        after={"current_stage": new_stage, "queue": queue_name, "owner": owner_id},
        description=f"Deal routed to queue '{queue_name}', owner {owner_id}.",
    )
    return {
        "deal_id": deal_id,
        "analyst_queue_id": queue_row["id"],
        "assigned_owner_id": owner_id,
        "previous_stage": previous_stage,
        "new_stage": new_stage,
    }


for _name, _fn in [
    ("record_deal_intake", record_deal_intake),
    ("persist_triage_draft", persist_triage_draft),
    ("apply_triage_review_decision", apply_triage_review_decision),
    ("route_deal_to_analyst_queue", route_deal_to_analyst_queue),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class ArtifactIn(BaseModel):
    artifact_type: str
    file_name: str
    content_type: str = "text/plain"
    content: str = ""


class IntakeRequest(BaseModel):
    borrower_name: str
    industry: str
    requested_amount: float
    ltv_percentage: float | None = None
    collateral_description: str = ""
    submitted_by_id: str
    artifacts: list[ArtifactIn] = []


class TriageAcceptRequest(BaseModel):
    decision: str = "accept"
    accepted_by_id: str
    accepted_queue: str | None = None


@router.post("/deals/intake")
def intake(req: IntakeRequest):
    context = {"inputs": req.model_dump()}
    result = record_deal_intake(context)
    deal = _get_deal(result["deal_id"])
    return {
        **_deal_view(deal),
        "intake": {
            "submitted_by_id": deal.get("submitted_by_id"),
            "created_at": deal.get("created_at"),
            "stored_artifact_ids": result["stored_artifact_ids"],
        },
        "artifacts": _artifacts_for(result["deal_id"]),
    }


@router.get("/deals")
def list_deals(authorization: str | None = Header(default=None)):
    rows = [_deal_view(d) for d in store.list("deals")]
    owner = _rm_scope(authorization)
    if owner is not None:
        rows = [r for r in rows if r.get("submitted_by_id") == owner]
    return rows


@router.get("/deals/{deal_id}")
def get_deal(deal_id: str, authorization: str | None = Header(default=None)):
    deal = _get_deal_or_404(deal_id)
    owner = _rm_scope(authorization)
    if owner is not None and deal.get("submitted_by_id") != owner:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    view = _deal_view(deal)
    view["artifacts"] = _artifacts_for(deal_id)
    view["triage"] = _latest_triage_output(deal_id)
    return view


@router.post("/deals/{deal_id}/triage/run")
def triage_run(deal_id: str):
    deal = _get_deal_or_404(deal_id)
    artifact_ids = [a["id"] for a in _artifacts_for(deal_id)]
    context = {
        "record_intake": {
            "deal_id": deal_id,
            "borrower_name": deal.get("borrower_name"),
            "industry": deal.get("industry"),
            "requested_amount": deal.get("requested_amount"),
            "ltv_percentage": deal.get("ltv_percentage"),
            "stored_artifact_ids": artifact_ids,
            "current_stage": deal.get("current_stage"),
        }
    }
    prompt = (
        f"You are the intake triage agent for deal {deal_id} (borrower {deal.get('borrower_name')}, "
        f"industry {deal.get('industry')}, requested exposure {deal.get('requested_amount')}). Read only the "
        f"stored source artifacts {artifact_ids}. Classify the request type and product type, judge whether it "
        "is suitable for underwriting, list every required document that is missing, and recommend the analyst "
        "queue it should be routed to. Do not spread financials, compute ratios, grade risk, or make any "
        "decision. Return a proposal only; a human will accept, edit, or reject it."
    )
    context["triage_request"] = {"reply": agent_runtime.respond(prompt)}
    try:
        result = persist_triage_draft(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "deal_id": deal_id,
        "triage_output_id": result["triage_output_id"],
        "request_type": result["request_type"],
        "product_type": result["product_type"],
        "underwriting_suitable": result["underwriting_suitable"],
        "missing_documents": result["missing_documents"],
        "recommended_queue": result["recommended_queue"],
        "rationale": result["rationale"],
        "draft_status": result["draft_status"],
        "draft": {"status": result["draft_status"], "triage_output_id": result["triage_output_id"]},
    }


@router.post("/deals/{deal_id}/triage/accept")
def triage_accept(deal_id: str, req: TriageAcceptRequest):
    deal = _get_deal_or_404(deal_id)
    triage_row = _latest_triage_output(deal_id)
    if triage_row is None or triage_row.get("draft_status") != "pending":
        raise HTTPException(status_code=400, detail="no pending triage proposal for this deal")
    context = {
        "record_intake": {
            "deal_id": deal_id,
            "borrower_name": deal.get("borrower_name"),
            "industry": deal.get("industry"),
        },
        "persist_triage_draft": {"deal_id": deal_id, "recommended_queue": triage_row.get("recommended_queue")},
        "decision_details": {
            "decision": req.decision,
            "accepted_by_id": req.accepted_by_id,
            "accepted_queue": req.accepted_queue,
        },
    }
    decision_result = apply_triage_review_decision(context)
    response = {
        "deal_id": deal_id,
        "accepted": decision_result["triage_status"] == "accepted",
        "triage_status": decision_result["triage_status"],
        "queue": decision_result["accepted_queue"],
        "accepted_by_id": decision_result["accepted_by_id"],
        "current_stage": deal["current_stage"],
    }
    if decision_result["triage_status"] == "accepted":
        route_context = {"record_intake": context["record_intake"], "apply_triage_decision": decision_result}
        try:
            route_result = route_deal_to_analyst_queue(route_context)
        except workflow_engine.WorkflowError as e:
            raise HTTPException(status_code=409, detail=str(e))
        response.update(
            {
                "current_stage": route_result["new_stage"],
                "previous_stage": route_result["previous_stage"],
                "assigned_owner_id": route_result["assigned_owner_id"],
                "analyst_queue_id": route_result["analyst_queue_id"],
            }
        )
    return response
