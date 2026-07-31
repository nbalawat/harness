"""Deal intake, intake triage, and the pipeline board (slice 1).

Routes live OUTSIDE /api/ on purpose: main.py ends with a generic
`/api/{table}` catch-all and anything registered under /api/... after it is
dead. Everything here is mounted from its own APIRouter.
"""
from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, model_validator

import drafts as draft_store
import underwriting as uw
import workflow_engine
from ext_auth import current_user

router = APIRouter()


# --------------------------------------------------------------------------
# Request models — validation happens before anything touches storage
# --------------------------------------------------------------------------


class JsonBody(BaseModel):
    """Request base model.

    Some harness clients (and plain `curl -d`) post the JSON document as a raw
    string rather than an object. Decode it first so validation always runs
    against a real object instead of failing with an opaque type error — every
    field check below still applies afterwards.
    """

    @model_validator(mode="before")
    @classmethod
    def _decode_string_body(cls, data):
        if isinstance(data, (str, bytes, bytearray)):
            try:
                decoded = json.loads(data)
            except (ValueError, TypeError):
                raise ValueError("request body must be a JSON object")
            if not isinstance(decoded, dict):
                raise ValueError("request body must be a JSON object")
            return decoded
        return data


class IntakeDocument(JsonBody):
    document_type: str
    original_filename: str
    content_type: str | None = None
    text: str | None = None
    upload_name: str | None = None


class DealSubmission(JsonBody):
    deal_reference: str
    borrower_name: str
    borrower_industry: str
    borrower_state: str | None = None
    facility_type: str
    requested_amount: float
    collateral_value: float | None = 0
    collateral_description: str | None = None
    purpose: str | None = None
    borrower_dba: str | None = None
    borrower_tin: str | None = None
    borrower_established: str | None = None
    borrower_address: str | None = None
    term_months: int | None = None
    submitted_by: str | None = None
    documents: list[IntakeDocument] = Field(default_factory=list)


class ActorRequest(JsonBody):
    acting_user: str | None = None


class ReviewRequest(JsonBody):
    action: str
    acting_user: str | None = None
    reason: str | None = None
    edits: dict | None = None


class PreflightRequest(JsonBody):
    borrower_name: str | None = None
    borrower_industry: str | None = None
    borrower_state: str | None = None
    facility_type: str | None = None
    requested_amount: float | None = 0
    collateral_value: float | None = 0


class IntakeDraftRequest(JsonBody):
    deal_reference: str
    content: dict
    acting_user: str | None = None


def _fail(exc: uw.DomainError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _run_view(run: dict | None) -> dict | None:
    if run is None:
        return None
    return {
        "id": run["id"],
        "agent_type": run.get("agent_type"),
        "agent_name": run.get("agent_name"),
        "model_id": run.get("model_id"),
        "prompt_template_version": run.get("prompt_template_version"),
        "latency_ms": run.get("latency_ms"),
        "token_cost": run.get("token_cost"),
        "ran_at": run.get("ran_at"),
    }


def _agent_run(run_id) -> dict | None:
    for row in uw.store.list("agent_runs"):
        if row["id"] == run_id:
            return row
    return None


def _draft_view(draft: dict) -> dict:
    content = draft.get("draft_content") or {}
    draft_type = draft.get("draft_type")
    return {
        "id": draft["id"],
        "deal_reference": draft.get("deal_reference"),
        "draft_type": draft_type,
        "artifact_label": uw.ARTIFACT_LABELS.get(draft_type, str(draft_type or "").replace("_", " ").title()),
        "agent_label": uw.AGENT_STAGE_LABELS.get(draft_type, str(draft_type or "")),
        "review_status": draft.get("review_status"),
        "review_action": draft.get("review_action"),
        "review_reason": draft.get("review_reason"),
        "reviewed_by_user_id": draft.get("reviewed_by_user_id"),
        "reviewed_at": draft.get("reviewed_at"),
        "human_edits": draft.get("human_edits"),
        "created_at": draft.get("created_at"),
        "agent_run_id": draft.get("agent_run_id"),
        "approval_item_id": draft.get("approval_item_id"),
        "classification": content.get("classification"),
        "classification_label": content.get("classification_label"),
        "missing_documents": content.get("missing_documents", []),
        "missing_document_labels": content.get("missing_document_labels", []),
        "proposed_queue": content.get("proposed_queue"),
        "proposed_queue_label": content.get("proposed_queue_label"),
        "proposed_analyst_user_id": content.get("proposed_analyst_user_id"),
        # financial spread (slice 2): every figure below carries a citation
        # naming the document + document location it came from, or is
        # explicitly "not supported by the record".
        "spread_line_items": content.get("spread_line_items"),
        "citations": content.get("citations"),
        "unsupported_line_items": content.get("unsupported_line_items"),
        "rationale": content.get("rationale"),
        "source": content.get("source"),
        "evidence": uw.draft_evidence(draft.get("deal_id"), draft_type, content),
        "draft_content": content,
        "agent_run": _run_view(_agent_run(draft.get("agent_run_id"))),
    }


# --------------------------------------------------------------------------
# Intake configuration & helpers (drive the Deal Intake screen)
# --------------------------------------------------------------------------


@router.get("/intake/config")
def intake_config():
    return {
        "stages": [{"index": i + 1, "slug": s, "label": uw.STAGE_LABELS[s]} for i, s in enumerate(uw.STAGES)],
        "facility_types": [
            {
                "slug": slug,
                "label": spec["label"],
                "ltv_cap": spec["ltv_cap"],
                "required_documents": spec["required_documents"],
            }
            for slug, spec in uw.FACILITY_TYPES.items()
        ],
        "document_types": [{"slug": t, "label": uw.DOCUMENT_TYPE_LABELS[t]} for t in uw.DOCUMENT_TYPES],
        "analyst_queues": [
            {"queue_id": q["queue_id"], "label": q["label"], "analyst_user_id": q["analyst_user_id"]}
            for q in uw.ANALYST_QUEUES
        ],
        "approval_tiers": {
            "analyst_ceiling": uw.TIER_ANALYST_CEILING,
            "officer_ceiling": uw.TIER_OFFICER_CEILING,
            "tier_rule_version": uw.TIER_RULE_VERSION,
            "required_roles": uw.TIER_REQUIRED_ROLE,
        },
        "users": [
            {
                "username": u["username"],
                "role": u["role"],
                "role_label": uw.ROLE_LABELS.get(u["role"], u["role"]),
                "display_name": u.get("display_name"),
            }
            for u in uw.store.list("users")
        ],
    }


@router.post("/intake/preflight")
def intake_preflight(req: PreflightRequest):
    """Deterministic advisory checks — read-only, writes nothing."""
    return uw.intake_preflight(
        borrower_name=req.borrower_name or "",
        borrower_industry=req.borrower_industry or "",
        borrower_state=req.borrower_state or "",
        facility_type=req.facility_type or "",
        requested_amount=float(req.requested_amount or 0),
        collateral_value=float(req.collateral_value or 0),
    )


@router.post("/intake/drafts")
def save_intake_draft(req: IntakeDraftRequest, authorization: str | None = Header(default=None)):
    """'Save draft' on the intake screen — versioned-drafts module, not a new store."""
    try:
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, uw.SUBMIT_ROLES)
    except uw.DomainError as exc:
        raise _fail(exc)
    reference = str(req.deal_reference or "").strip()
    if not uw.DEAL_REFERENCE_RE.match(reference):
        raise HTTPException(status_code=400, detail="a valid deal_reference is required to save an intake draft")
    saved = draft_store.save(f"intake:{reference}", req.content)
    uw.audit_event(
        event_type="intake_draft.saved",
        action="intake form saved as a draft",
        actor_user_id=actor["username"],
        deal_reference=reference,
        entity_type="_drafts",
        entity_id=saved["id"],
    )
    return {"deal_reference": reference, "draft_id": saved["id"], "saved_by": actor["username"], "state": saved["state"]}


@router.get("/intake/drafts/{deal_reference}")
def get_intake_draft(deal_reference: str):
    saved = draft_store.draft(f"intake:{deal_reference}")
    if saved is None:
        raise HTTPException(status_code=404, detail="no saved intake draft for that reference")
    return {"deal_reference": deal_reference, "content": saved["content"], "draft_id": saved["id"]}


# --------------------------------------------------------------------------
# Deals
# --------------------------------------------------------------------------


_CSV_FORMULA_LEADERS = ("=", "+", "-", "@", "\t", "\r")


def _csv_cell(value):
    """Neutralise spreadsheet formula injection (FSI hardening rule 1).

    Borrower name / industry / state / deal_reference are attacker-supplied and
    land in an examiner's spreadsheet. A leading '=', '+', '-', '@', TAB or CR
    makes Excel and Sheets evaluate the cell, so those cells are prefixed with
    an apostrophe and kept as text. Numbers are emitted untouched.
    """
    if value is None or isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    return "'" + text if text.startswith(_CSV_FORMULA_LEADERS) else text


@router.get("/deals/export.csv")
def export_board_csv(stage: str | None = Query(default=None)):
    """Pipeline-board export: the *view* the officer is looking at, including
    derived columns (idle business days, stage index) that the generic
    /export/{table}.csv table dump cannot produce."""
    columns = [
        "deal_reference",
        "borrower_name",
        "borrower_industry",
        "borrower_state",
        "facility_type",
        "exposure_amount",
        "approval_tier",
        "current_stage",
        "stage_index",
        "assigned_analyst_id",
        "submitted_by_user_id",
        "document_count",
        "business_days_idle",
        "created_at",
        "last_activity_at",
    ]
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for deal in uw.all_deals():
        if stage and deal.get("current_stage") != stage:
            continue
        view = uw.deal_view(deal)
        view["business_days_idle"] = uw.business_days_idle(deal.get("last_activity_at"))
        writer.writerow({key: _csv_cell(view.get(key)) for key in columns})
    return PlainTextResponse(out.getvalue(), media_type="text/csv")


@router.get("/deals")
def list_deals(stage: str | None = Query(default=None), tier: str | None = Query(default=None)):
    deals = [uw.deal_view(d) for d in uw.all_deals()]
    if stage:
        deals = [d for d in deals if d.get("current_stage") == stage]
    if tier:
        deals = [d for d in deals if d.get("approval_tier") == tier]
    return deals


@router.post("/deals")
def submit_deal(req: DealSubmission, authorization: str | None = Header(default=None)):
    """A relationship manager submits a borrower's request with its documents.

    Runs the approved `deal-underwriting` process: the engine performs the
    deterministic intake writes, runs the intake triage agent node, then parks
    on the `triage_review` human node. Nothing advances without a named human.
    """
    payload = req.model_dump()
    try:
        clean = uw.validate_submission(payload)
        actor = uw.resolve_actor(current_user(authorization), req.submitted_by, uw.SUBMIT_ROLES)
    except uw.DomainError as exc:
        raise _fail(exc)

    payload["submitted_by"] = actor["username"]
    fingerprint = uw.submission_fingerprint(payload)

    existing = uw.find_deal(clean["deal_reference"])
    if existing is not None:
        # Replay-safe: an identical resubmission returns the deal of record.
        if existing.get("submission_fingerprint") != fingerprint:
            raise HTTPException(
                status_code=409,
                detail=f"deal_reference '{clean['deal_reference']}' already exists with different submission details",
            )
        uw.audit_event(
            event_type="deal.submission_replayed",
            action="identical intake submission received again; no new deal created",
            actor_user_id=actor["username"],
            deal_id=existing["id"],
            deal_reference=existing["deal_reference"],
            entity_type="deals",
            entity_id=existing["id"],
        )
        return _deal_response(existing, replayed=True)

    correlation = uw.correlation_id()
    # The workflow run record is a durable, examinable artefact of the process.
    # A full TIN/EIN must never land in it: the validated submission already
    # carries `borrower_tin_masked` (last four only), so the raw value is
    # dropped before the payload crosses into the engine.
    run_payload = {k: v for k, v in payload.items() if k not in uw.SENSITIVE_SUBMISSION_FIELDS}
    run_payload["borrower_tin_masked"] = clean["borrower_tin_masked"]
    run_id, elapsed_ms = uw.start_intake_workflow(run_payload)
    deal = uw.find_deal(clean["deal_reference"])
    if deal is None:
        state = workflow_engine.state(run_id) if run_id else {}
        raise HTTPException(
            status_code=500,
            detail=f"intake workflow did not register the deal: {state.get('error', 'unknown error')}",
        )
    if run_id and not deal.get("workflow_run_id"):
        deal["workflow_run_id"] = run_id
    deal["correlation_id"] = correlation
    uw.store.save("deals", deal)
    # The run already executed the triage agent node; adopt that output as the
    # pending draft rather than prompting the same agent a second time.
    uw.adopt_workflow_triage(deal, run_id, elapsed_ms, actor["username"])
    uw._log("deal.submitted", deal_reference=deal["deal_reference"], correlation_id=correlation, workflow_run_id=run_id)
    return _deal_response(deal, replayed=False)


def _deal_response(deal: dict, *, replayed: bool) -> dict:
    view = uw.deal_view(deal)
    run_id = deal.get("workflow_run_id")
    workflow_state = None
    if run_id:
        try:
            state = workflow_engine.state(run_id)
            workflow_state = {"run_id": run_id, "status": state.get("status"), "approval_id": state.get("approval_id")}
        except Exception:
            workflow_state = {"run_id": run_id, "status": "unknown"}
    draft = uw.pending_draft(deal["id"], "triage")
    return {
        "deal": view,
        "deal_reference": deal["deal_reference"],
        "current_stage": deal["current_stage"],
        "approval_tier": deal["approval_tier"],
        "exposure_amount": deal["exposure_amount"],
        "tier_rule_version": uw.TIER_RULE_VERSION,
        "required_role": uw.TIER_REQUIRED_ROLE.get(deal["approval_tier"]),
        "workflow": workflow_state,
        "preflight": uw.intake_preflight(
            borrower_name=deal["borrower_name"],
            borrower_industry=deal["borrower_industry"],
            borrower_state=deal.get("borrower_state") or "",
            facility_type=deal["facility_type"],
            requested_amount=deal["requested_amount"],
            collateral_value=deal.get("collateral_value") or 0,
            exclude_deal_reference=deal["deal_reference"],
        ),
        "triage_draft": _draft_view(draft) if draft else None,
        "replayed": replayed,
    }


@router.get("/deals/{deal_reference}")
def get_deal(deal_reference: str):
    try:
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise _fail(exc)
    response = _deal_response(deal, replayed=False)
    response["documents"] = uw.documents_for(deal["id"])
    response["drafts"] = [_draft_view(d) for d in uw.drafts_for(deal["id"])]
    response["stage_transitions"] = [t for t in uw.store.list("stage_transitions") if t.get("deal_id") == deal["id"]]
    response["business_days_idle"] = uw.business_days_idle(deal.get("last_activity_at"))
    return response


@router.post("/deals/{deal_reference}/triage")
def run_triage(deal_reference: str, req: ActorRequest, authorization: str | None = Header(default=None)):
    """Materialise the intake triage draft: a classification, a missing-document
    list, and a proposed analyst queue — PENDING until a named human acts."""
    try:
        deal = uw.require_deal(deal_reference)
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, uw.TRIAGE_ROLES)
    except uw.DomainError as exc:
        raise _fail(exc)

    draft = uw.pending_draft(deal["id"], "triage")
    created = False
    if draft is None:
        draft = uw.build_triage_draft(deal, actor["username"])
        created = True
    view = _draft_view(draft)
    view["created"] = created
    view["deal"] = uw.deal_view(deal)
    return view


@router.post("/deals/{deal_reference}/spread")
def run_spread(deal_reference: str, req: ActorRequest, authorization: str | None = Header(default=None)):
    """Materialise the financial spread draft: every standard-template line
    filled from the deal's extracted document locations alone, with a
    citation on every figure it does find — PENDING until a named human
    accepts, edits, or rejects it."""
    try:
        deal = uw.require_deal(deal_reference)
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, uw.SPREAD_ROLES)
    except uw.DomainError as exc:
        raise _fail(exc)

    if deal.get("current_stage") not in ("document_extraction", "financial_spreading"):
        raise HTTPException(
            status_code=409,
            detail=(
                "deal must have an accepted intake triage draft (stage document_extraction or "
                f"financial_spreading) before it can be spread — currently at '{deal.get('current_stage')}'"
            ),
        )

    draft = uw.pending_draft(deal["id"], "spread")
    created = False
    if draft is None:
        draft = uw.adopt_workflow_spread(deal, actor["username"]) or uw.build_spread_draft(deal, actor["username"])
        created = True
    view = _draft_view(draft)
    view["created"] = created
    view["deal"] = uw.deal_view(deal)
    return view


@router.get("/deals/{deal_reference}/drafts")
def list_drafts(deal_reference: str, draft_type: str | None = Query(default=None)):
    try:
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise _fail(exc)
    return [_draft_view(d) for d in uw.drafts_for(deal["id"], draft_type)]


@router.post("/deals/{deal_reference}/drafts/{draft_type}/review")
def review_draft(
    deal_reference: str,
    draft_type: str,
    req: ReviewRequest,
    authorization: str | None = Header(default=None),
):
    """The human gate. Only acceptance promotes a draft into deal-of-record
    data; a rejection without a written reason is refused."""
    try:
        deal = uw.require_deal(deal_reference)
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, uw.DRAFT_REVIEW_ROLES)
        outcome = uw.review_draft(
            deal=deal,
            draft_type=draft_type,
            action=str(req.action or "").strip().lower(),
            actor=actor,
            reason=req.reason,
            edits=req.edits,
        )
    except uw.DomainError as exc:
        raise _fail(exc)
    view = _draft_view(outcome["draft"])
    return {
        "deal_reference": deal["deal_reference"],
        "review_action": view["review_action"],
        "review_status": view["review_status"],
        "reviewed_by_user_id": view["reviewed_by_user_id"],
        "current_stage": deal["current_stage"],
        "promoted": outcome["promoted"],
        "draft": view,
        "deal": uw.deal_view(deal),
    }


# --------------------------------------------------------------------------
# Draft Review workspace — one acceptance queue across every agent draft type
# (REQ-046). Deal-scoped drafts stay under /deals/{ref}/drafts above; this is
# the cross-deal view the workspace's queue table binds to.
# --------------------------------------------------------------------------


@router.get("/drafts")
def list_all_drafts(review_status: str | None = Query(default=None), draft_type: str | None = Query(default=None)):
    rows = uw.all_drafts()
    if review_status:
        rows = [r for r in rows if r.get("review_status") == review_status]
    if draft_type:
        rows = [r for r in rows if r.get("draft_type") == draft_type]
    rows = sorted(rows, key=lambda r: r.get("created_at") or "", reverse=True)
    return [uw.draft_queue_view(r) for r in rows]


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: str):
    for row in uw.all_drafts():
        if str(row["id"]) == draft_id:
            view = _draft_view(row)
            deal = uw.find_deal(row.get("deal_reference"))
            view["deal"] = uw.deal_view(deal) if deal else None
            return view
    raise HTTPException(status_code=404, detail=f"unknown draft '{draft_id}'")


# --------------------------------------------------------------------------
# Pipeline board
# --------------------------------------------------------------------------


@router.get("/pipeline")
def pipeline():
    board = uw.pipeline_board()
    for deal in board["deals"]:
        deal["business_days_idle"] = uw.business_days_idle(deal.get("last_activity_at"))
    return board
