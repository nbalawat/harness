"""ext_deal_intake: slice `deal-intake-and-triage`.

An RM files an SMB loan request; it becomes a tracked deal. The Intake Triage
Agent classifies it, flags missing documents, and recommends an analyst
queue. Only after an analyst explicitly *accepts* that proposal is the deal
routed — visible to everyone on the pipeline board, grouped by stage.

Two of the `deal-underwriting-lifecycle` workflow's deterministic node
handlers are implemented and registered here (validate_intake_submission for
node `intake`, record_triage_and_route_to_queue for node `route`) so their
contracts are real, callable functions per the workflow-authoring convention.
They are invoked directly from the REST endpoints below rather than through
workflow_engine.start()/tick() — later slices in this lifecycle (spreading,
grading, memo, policy, approval) are built as separate slices with their own
handlers, and driving the shared generic run all the way through nodes this
slice does not own would fail on handlers that do not exist yet.
"""
import datetime
import time

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import agent_runtime
import assignment
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

REQUIRED_DOCUMENT_TYPES = ["balance_sheet", "income_statement", "tax_return"]
ANALYST_QUEUES = ["standard_underwriting_queue", "complex_credit_queue"]
ANALYST_POOL = ["analyst@bank.test"]


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ------------------------------------------------------------------------
# workflow-engine handlers (deal-underwriting-lifecycle: intake, route)
# ------------------------------------------------------------------------

def validate_intake_submission(context):
    """Node `intake`: R-040/R-046 — schema-checking, deterministic on purpose."""
    inputs = context.get("inputs", context)
    # Guarded here too, not only in the REST handler: this node is also
    # reachable through workflow_engine.start(), so the authority check has to
    # live at the point of the state change.
    user = identity.require_actor(
        inputs.get("acting_user_email") or inputs.get("submitted_by_user_id"),
        "deal.submit",
        "file a new deal",
    )
    valid = bool(
        inputs.get("borrower_name")
        and inputs.get("borrower_industry")
        and float(inputs.get("requested_amount") or 0) > 0
        and float(inputs.get("exposure_amount") or 0) > 0
    )
    deal = None
    if valid:
        deal = deals_repo.create_deal({
            "borrower_name": inputs["borrower_name"],
            "borrower_industry": inputs["borrower_industry"],
            "borrower_entity_id": inputs.get("borrower_entity_id"),
            "requested_amount": inputs["requested_amount"],
            "exposure_amount": inputs["exposure_amount"],
            "current_stage": "intake",
            "current_status": "pending_triage",
            "created_by_user_id": user["id"],
            "assigned_to_user_id": None,
            "risk_grade": None,
            "decline_reason_code": None,
            "decline_reason_detail": None,
            "last_activity_timestamp": _now(),
        })
    entry = audit("deal.intake_submitted", {
        "deal_id": deal["deal_code"] if deal else None,
        "actor_user_id": user["id"],
        "resource_type": "deal",
        "resource_id": deal["deal_code"] if deal else None,
        "after": deal,
    })
    return {
        "deal_id": deal["deal_code"] if deal else None,
        "valid": valid,
        "borrower_name": inputs.get("borrower_name"),
        "borrower_industry": inputs.get("borrower_industry"),
        "requested_amount": inputs.get("requested_amount"),
        "exposure_amount": inputs.get("exposure_amount"),
        "submitted_by_user_id": user["id"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("validate_intake_submission", validate_intake_submission)


def record_triage_and_route_to_queue(context):
    """Node `route`: persists the human-accepted triage decision and assigns
    the deal to an analyst queue. R-023/R-055 keep this deterministic — no
    agent holds a queue-assignment or advance-stage tool."""
    deal_code = context["deal_id"]
    queue_name = context["recommended_queue"]
    actor_user_id = context.get("actor_user_id")
    # Same reasoning as the intake node: this routing step is a state change,
    # so it re-verifies the acting analyst's authority rather than trusting
    # whoever assembled the context (REST handler or workflow run).
    actor = next((u for u in store.list("users") if u.get("id") == actor_user_id), None)
    if not identity.has_permission(actor, "deal.triage"):
        raise HTTPException(status_code=403, detail="lacks the authority to route a triaged deal")
    assignee_email = assignment.round_robin(list(ANALYST_POOL), queue=queue_name)
    assignee = identity.resolve_user(assignee_email, default_role="credit_analyst")
    qa = store.insert("queue_assignments", {
        "deal_id": deal_code,
        "queue_name": queue_name,
        "assigned_to_user_id": assignee["id"],
        "claimed_by_user_id": None,
        "claimed_at": None,
        "status": "assigned",
        "created_at": _now(),
        "updated_at": _now(),
    })
    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": actor_user_id,
        "action": "accept",
        "original_content": context.get("triage_output"),
        "edited_content": None,
        "rejection_reason": None,
        "reviewed_at": _now(),
    })
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="document_extraction",
        current_status="documents_pending",
        assigned_to_user_id=assignee["id"],
        last_activity_timestamp=_now(),
    )
    entry = audit("deal.triage_accepted_and_routed", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "deal",
        "resource_id": deal_code,
        "before": {"current_stage": "intake"},
        "after": updated,
    })
    return {
        "queue_assignment_id": qa["id"],
        "queue_name": queue_name,
        "assigned_to_user_id": assignee["id"],
        "triage_decision_id": context.get("triage_decision_id"),
        "review_id": review["id"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_triage_and_route_to_queue", record_triage_and_route_to_queue)


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

class DealCreateRequest(BaseModel):
    borrower_name: str
    borrower_industry: str
    requested_amount: float
    exposure_amount: float
    acting_user_email: str
    borrower_entity_id: str | None = None


class ActingUserRequest(BaseModel):
    acting_user_email: str


@router.post("/api/deals", status_code=201)
def create_deal(req: DealCreateRequest):
    identity.require_actor(req.acting_user_email, "deal.submit", "file a new deal")
    result = validate_intake_submission({"inputs": req.model_dump()})
    if not result["valid"]:
        raise HTTPException(
            status_code=400,
            detail="borrower_name, borrower_industry, requested_amount, and exposure_amount are all required and amounts must be positive",
        )
    deal = deals_repo.get_deal(result["deal_id"])
    return {**deal, "message": f"Deal {deal['deal_code']} created and entered intake."}


def _reader(acting_user_email, x_user_email, action):
    """Resolve the caller of a read. UNCONDITIONAL and fail-closed: identity may
    arrive as a query parameter or an `x-user-email` header, an identity that
    resolves to no stored user is a 403 (never a silent fallback to full
    access), and an unidentified caller reads as the least-privilege
    ANONYMOUS_VIEWER, whose rows `identity.visible_deals` redacts to the board
    projection."""
    return identity.require_reader(acting_user_email or x_user_email, action=action)


@router.get("/api/deals")
def list_deals(
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """The deal book, always scoped to the caller — a relationship manager sees
    only the deals it filed or holds, the analyst/officer desk sees the whole
    book, and an unidentified caller gets the redacted board projection."""
    reader = _reader(acting_user_email, x_user_email, "read the deal book")
    return identity.visible_deals(reader, deals_repo.all_current_deals())


@router.get("/api/pipeline")
def pipeline_board(
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """Every deal the caller may see, grouped by the stage it presently
    occupies — the pipeline board. Scoped and redacted through the same
    `visible_deals` guard as the deal book, so the board can never be used as a
    way around the deal book's access control."""
    reader = _reader(acting_user_email, x_user_email, "read the pipeline board")
    deals = identity.visible_deals(reader, deals_repo.all_current_deals())
    columns = {}
    for d in deals:
        columns.setdefault(d.get("current_stage") or "intake", []).append(d)
    return {"deals": deals, "columns": columns, "scoped_to": reader.get("role")}


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _missing_documents(deal_code):
    attached = {d["document_type"] for d in store.list("documents") if d.get("deal_id") == deal_code}
    return [t for t in REQUIRED_DOCUMENT_TYPES if t not in attached]


@router.post("/api/deals/{deal_code}/agents/intake-triage/run")
def run_intake_triage(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.triage", "run the intake triage agent")

    missing = _missing_documents(deal_code)
    complexity = "complex" if float(deal.get("requested_amount") or 0) > 250000 else "standard"
    classification = f"{deal.get('borrower_industry') or 'unclassified'} SMB loan request — {complexity} complexity"
    recommended_queue = ANALYST_QUEUES[1] if complexity == "complex" else ANALYST_QUEUES[0]

    # Confidence and routing are computed deterministically (the agent's
    # narrative is advisory context, not the source of these guarantees) —
    # the roster's eval_criteria require recommended_queue to always be a
    # supplied queue name and confidence_score to always be in [0, 1].
    confidence = 0.9
    if not deal.get("borrower_industry"):
        confidence -= 0.3
    if not float(deal.get("requested_amount") or 0) > 0:
        confidence -= 0.3
    confidence -= 0.1 * len(missing)
    confidence = max(0.0, min(1.0, round(confidence, 2)))

    prompt = (
        f"You are the intake triage agent. Classify loan request {deal_code} for borrower "
        f"{deal.get('borrower_name')} in industry {deal.get('borrower_industry')}, requested "
        f"amount {deal.get('requested_amount')}, exposure {deal.get('exposure_amount')}. "
        f"Documents still missing: {missing}. Recommend one of these queues: {ANALYST_QUEUES}. "
        "You may not approve, decline, grade, price, or advance this deal; this is a proposal "
        "for a human analyst to accept."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Intake Triage Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    decision = store.insert("intake_triage_decisions", {
        "deal_id": deal_code,
        "classification": classification,
        "missing_documents": missing,
        "confidence_score": confidence,
    })
    attached_types = sorted({d["document_type"] for d in store.list("documents") if d.get("deal_id") == deal_code})
    output_content = {
        "classification": classification,
        "missing_documents": missing,
        "recommended_queue": recommended_queue,
        "confidence_score": confidence,
        "narrative": narrative,
    }
    output = store.insert("agent_outputs", {
        "deal_id": deal_code,
        "agent_id": "intake-triage",
        "stage": "intake",
        "model": agent_runtime.mode().get("detail"),
        "prompt_version": "v1",
        "input_data": {"deal_code": deal_code, "documents_attached": attached_types},
        "output_content": output_content,
        "token_usage": None,
        "latency_ms": latency_ms,
        "outcome": "proposed",
        "generated_at": _now(),
    })
    audit("triage.agent_run", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "agent_output",
        "resource_id": output["id"],
        "after": output_content,
    })
    return {
        "deal_id": deal_code,
        "agent_output_id": output["id"],
        "triage_decision_id": decision["id"],
        **output_content,
    }


@router.post("/api/deals/{deal_code}/triage/accept")
def accept_triage(deal_code: str, req: ActingUserRequest):
    _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.triage", "accept a triage proposal")

    decisions = [d for d in store.list("intake_triage_decisions") if d.get("deal_id") == deal_code]
    if not decisions:
        raise HTTPException(status_code=409, detail="run the intake triage agent before accepting its proposal")
    decision = decisions[-1]
    outputs = [o for o in store.list("agent_outputs") if o.get("deal_id") == deal_code and o.get("agent_id") == "intake-triage"]
    output = outputs[-1] if outputs else None
    recommended_queue = output["output_content"]["recommended_queue"] if output else ANALYST_QUEUES[0]

    result = record_triage_and_route_to_queue({
        "deal_id": deal_code,
        "recommended_queue": recommended_queue,
        "actor_user_id": actor["id"],
        "triage_decision_id": decision["id"],
        "agent_output_id": output["id"] if output else None,
        "triage_output": output["output_content"] if output else None,
    })
    updated_deal = deals_repo.get_deal(deal_code)
    return {**result, "deal_id": deal_code, "current_stage": updated_deal["current_stage"]}
