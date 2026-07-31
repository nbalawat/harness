"""Financial spreading + the Draft Review workspace (slice 2).

Routes live OUTSIDE /api/ on purpose: main.py ends with a generic
`/api/{table}` catch-all and anything registered under /api/... after it is
dead. Everything here is mounted from its own APIRouter.

The review workspace serves EVERY agent draft in the app (triage today, spread
here, memo and compliance in later slices) through one queue + one gate, which
is the point of the screen: a draft only becomes deal-of-record data when a
named human accepts it.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query

import spreading
import underwriting as uw
from ext_auth import current_user
from ext_deals import ActorRequest, _draft_view, _fail

router = APIRouter()

#: Draft type -> how the queue labels it (the design's "Artifact" column).
ARTIFACT_LABELS = {
    "triage": "Triage classification",
    "spread": "Financial spread",
    "memo": "Credit memo",
    "compliance": "Policy exception set",
}

AGENT_LABELS = {
    "triage": "1 · Intake triage",
    "spread": "2 · Spreading",
    "memo": "3 · Memo",
    "compliance": "4 · Policy compliance",
}


def _visible_deals(authorization: str | None) -> dict:
    return {deal["id"]: deal for deal in uw.visible_deals(current_user(authorization))}


def _require_visible(deal_reference: str, authorization: str | None) -> dict:
    """Resolve a deal and hold row scoping on it — naming a reference must not
    walk around the scoping applied to the board."""
    try:
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise _fail(exc)
    caller = current_user(authorization)
    if caller and deal["id"] not in _visible_deals(authorization):
        raise HTTPException(status_code=404, detail=f"no deal '{deal_reference}' in your scope")
    return deal


def _queue_row(draft: dict, deal: dict) -> dict:
    run = None
    for row in uw.store.list("agent_runs"):
        if row["id"] == draft.get("agent_run_id"):
            run = row
            break
    content = draft.get("draft_content") or {}
    draft_type = draft.get("draft_type")
    return {
        "id": draft["id"],
        "deal_reference": deal.get("deal_reference"),
        "borrower_name": deal.get("borrower_name"),
        "current_stage": deal.get("current_stage"),
        "stage_label": uw.STAGE_LABELS.get(deal.get("current_stage"), deal.get("current_stage")),
        "approval_tier": deal.get("approval_tier"),
        "draft_type": draft_type,
        "artifact_label": ARTIFACT_LABELS.get(draft_type, uw.STAGE_LABELS.get(draft_type, draft_type)),
        "agent_label": AGENT_LABELS.get(draft_type, draft_type),
        "review_status": draft.get("review_status"),
        "reviewed_by_user_id": draft.get("reviewed_by_user_id"),
        "created_at": draft.get("created_at"),
        "business_days_idle": uw.business_days_idle(draft.get("created_at")),
        "agent_run_id": draft.get("agent_run_id"),
        "agent_name": (run or {}).get("agent_name"),
        "model_id": (run or {}).get("model_id"),
        "prompt_template_version": (run or {}).get("prompt_template_version"),
        "latency_ms": (run or {}).get("latency_ms"),
        "prompt_tokens": (run or {}).get("prompt_tokens"),
        "completion_tokens": (run or {}).get("completion_tokens"),
        "token_cost": (run or {}).get("token_cost"),
        "supported_line_items": (content.get("coverage") or {}).get("supported"),
        "template_lines": (content.get("coverage") or {}).get("template_lines"),
        "citation_count": len(content.get("citations") or []),
    }


# --------------------------------------------------------------------------
# The acceptance queue (Draft Review screen)
# --------------------------------------------------------------------------


@router.get("/drafts")
def list_all_drafts(
    status: str | None = Query(default=None),
    draft_type: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    """Every agent draft the caller is entitled to see, newest last.

    Summaries only — the draft body and its cited evidence are read one at a
    time through /drafts/{id}, so a queue read never becomes a bulk dump of
    borrower document text.
    """
    deals = _visible_deals(authorization)
    rows = [d for d in uw.store.list("agent_drafts") if d.get("deal_id") in deals]
    if status:
        rows = [d for d in rows if d.get("review_status") == status]
    if draft_type:
        rows = [d for d in rows if d.get("draft_type") == draft_type]
    queue = [_queue_row(draft, deals[draft["deal_id"]]) for draft in rows]
    return {
        "drafts": queue,
        "counts": {
            "total": len(queue),
            "pending": len([d for d in queue if d["review_status"] == "pending"]),
            "accepted": len([d for d in queue if d["review_status"] in ("accepted", "edited")]),
            "rejected": len([d for d in queue if d["review_status"] == "rejected"]),
        },
    }


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: int, authorization: str | None = Header(default=None)):
    """One draft with its body and the evidence each figure cites."""
    deals = _visible_deals(authorization)
    draft = None
    for row in uw.store.list("agent_drafts"):
        if row["id"] == draft_id:
            draft = row
            break
    if draft is None or draft.get("deal_id") not in deals:
        raise HTTPException(status_code=404, detail=f"no draft {draft_id} in your scope")
    deal = deals[draft["deal_id"]]
    view = _draft_view(draft)
    view["queue"] = _queue_row(draft, deal)
    view["deal"] = uw.deal_view(deal)
    view["spread_of_record"] = spreading.spread_view(deal) if draft.get("draft_type") == "spread" else None
    return view


# --------------------------------------------------------------------------
# The financial spreading agent
# --------------------------------------------------------------------------


@router.post("/deals/{deal_reference}/spread")
def run_spread(deal_reference: str, req: ActorRequest, authorization: str | None = Header(default=None)):
    """Run the financial spreading agent over this deal's extracted document
    locations and park the standard spread template as a PENDING draft.

    Every figure carries a citation naming the document and the document
    location it came from; a template line the documents cannot support says
    'not supported by the record' rather than carrying a number. Nothing is
    persisted as deal-of-record data here — a named human accepts first.
    """
    deal = _require_visible(deal_reference, authorization)
    try:
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, spreading.SPREAD_ROLES)
        outcome = spreading.start_spread(deal, actor)
    except uw.DomainError as exc:
        raise _fail(exc)
    view = _draft_view(outcome["draft"])
    view["created"] = outcome["created"]
    view["deal"] = uw.deal_view(deal)
    view["template_version"] = spreading.SPREAD_TEMPLATE_VERSION
    view["queue"] = _queue_row(outcome["draft"], deal)
    return view


@router.get("/deals/{deal_reference}/spread")
def get_spread(deal_reference: str, authorization: str | None = Header(default=None)):
    """The deal's spread of record — accepted line items with their citations."""
    deal = _require_visible(deal_reference, authorization)
    view = spreading.spread_view(deal)
    draft = uw.pending_draft(deal["id"], "spread")
    view["pending_draft_id"] = draft["id"] if draft else None
    view["current_stage"] = deal.get("current_stage")
    return view


@router.get("/spread/template")
def spread_template():
    """The standard spread template the agent must fill — inspectable, versioned."""
    return {
        "template_version": spreading.SPREAD_TEMPLATE_VERSION,
        "categories": [
            {"slug": slug, "label": label} for slug, label in spreading.CATEGORY_LABELS.items()
        ],
        "line_items": [
            {"line_item_key": line["key"], "category": line["category"], "label": line["label"], "unit": "USD"}
            for line in spreading.SPREAD_TEMPLATE
        ],
        "unsupported_statement": spreading.NOT_SUPPORTED,
        "review_roles": sorted(spreading.SPREAD_ROLES),
    }
