"""Financial spreading + the Draft Review workspace (slice 2).

Routes live OUTSIDE /api/ on purpose: main.py ends with a generic
`/api/{table}` catch-all and anything registered under /api/... after it is
dead. Everything here is mounted from its own APIRouter.

The workspace is deliberately artefact-agnostic: it serves every agent draft in
the app (the slice-1 triage draft as well as this slice's spread), because
REQ-046 asks for one seat where a named human sees the draft beside the
evidence each figure cites and accepts, edits, or rejects it.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query

import spreading
import underwriting as uw
from ext_auth import current_user
from ext_deals import ActorRequest, draft_view, fail

router = APIRouter()


class SpreadRunRequest(ActorRequest):
    """POST /deals/{ref}/spread — a named human asks for the spread draft."""


def _visible_deal(deal_reference: str, authorization: str | None) -> dict:
    """Resolve a deal with the same row scoping the board applies, so naming a
    reference can never walk around it (REQ-019)."""
    try:
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise fail(exc)
    caller = current_user(authorization)
    if caller and deal["id"] not in {d["id"] for d in uw.visible_deals(caller)}:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_reference}' in your scope")
    return deal


def _deal_summary(deal: dict) -> dict:
    view = uw.deal_view(deal)
    return {
        "deal_reference": view["deal_reference"],
        "borrower_name": view["borrower_name"],
        "borrower_industry": view.get("borrower_industry"),
        "borrower_state": view.get("borrower_state"),
        "facility_type": view.get("facility_type"),
        "facility_label": view.get("facility_label"),
        "exposure_amount": view.get("exposure_amount"),
        "approval_tier": view.get("approval_tier"),
        "current_stage": view.get("current_stage"),
        "stage_label": view.get("stage_label"),
        "stage_index": view.get("stage_index"),
        "assigned_analyst_id": view.get("assigned_analyst_id"),
        "submitted_by_user_id": view.get("submitted_by_user_id"),
        "document_count": view.get("document_count"),
        "pending_draft_types": view.get("pending_draft_types", []),
        "business_days_idle": uw.business_days_idle(deal.get("last_activity_at")),
        "can_run_spread": (
            deal.get("current_stage") in spreading.SPREAD_FROM_STAGES
            and uw.pending_draft(deal["id"], "spread") is None
        ),
    }


def _queue_row(draft: dict, deal: dict) -> dict:
    view = draft_view(draft)
    run = view.get("agent_run") or {}
    return {
        "id": view["id"],
        "deal_reference": view["deal_reference"],
        "borrower_name": deal.get("borrower_name"),
        "draft_type": view["draft_type"],
        "artifact_label": view["artifact_label"],
        "agent_label": view["agent_label"],
        "review_status": view["review_status"],
        "reviewed_by_user_id": view.get("reviewed_by_user_id"),
        "model_id": run.get("model_id"),
        "prompt_template_version": run.get("prompt_template_version"),
        "latency_ms": run.get("latency_ms"),
        "token_cost": run.get("token_cost"),
        "tokens_in_estimated": run.get("tokens_in_estimated"),
        "tokens_out_estimated": run.get("tokens_out_estimated"),
        "created_at": view.get("created_at"),
        "business_days_idle": uw.business_days_idle(view.get("created_at")),
        "current_stage": deal.get("current_stage"),
        "stage_label": uw.STAGE_LABELS.get(deal.get("current_stage"), deal.get("current_stage")),
        "submitted_by_user_id": deal.get("submitted_by_user_id"),
    }


def _evidence_for(draft: dict, deal: dict) -> list[dict]:
    """The cited-evidence column: for every figure, the document location it
    was read from — re-read from the store so what the reviewer sees is the
    stored document text, not a copy the draft carried."""
    content = draft.get("draft_content") or {}
    documents = {d["id"]: d for d in uw.documents_for(deal["id"])}
    locations = {loc["id"]: loc for loc in uw.locations_for(list(documents))}

    if draft.get("draft_type") == "spread":
        evidence = []
        for citation in content.get("citations") or []:
            location = locations.get(citation.get("document_location_id"))
            document = documents.get(citation.get("document_id"))
            evidence.append(
                {
                    "line_item_key": citation.get("line_item_key"),
                    "source_reference": citation.get("source_reference"),
                    "source_type": citation.get("source_type"),
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                    "document_name": (document or {}).get("original_filename") or citation.get("document_name"),
                    "document_type": (document or {}).get("document_type"),
                    "page_number": (location or {}).get("page_number") or citation.get("page_number"),
                    "section": (location or {}).get("section") or citation.get("section"),
                    "excerpt": str((location or {}).get("extracted_text") or citation.get("excerpt") or "")[:300],
                    "cited_value": citation.get("cited_value"),
                    "verified": bool(location) or citation.get("source_type") == "human_correction",
                }
            )
        return evidence

    # Triage draft: the evidence is the documents the classification was drawn
    # from, with the page count actually extracted from each.
    evidence = []
    for document in documents.values():
        pages = [loc["page_number"] for loc in locations.values() if loc.get("document_id") == document["id"]]
        first = next((loc for loc in locations.values() if loc.get("document_id") == document["id"]), None)
        evidence.append(
            {
                "line_item_key": document.get("document_type"),
                "source_reference": f"{document.get('original_filename')} · {max(pages) if pages else 0} page(s) extracted",
                "source_type": "document",
                "document_id": document["id"],
                "document_location_id": (first or {}).get("id"),
                "document_name": document.get("original_filename"),
                "document_type": document.get("document_type"),
                "page_number": (first or {}).get("page_number"),
                "section": (first or {}).get("section"),
                "excerpt": str((first or {}).get("extracted_text") or "no extractable text on file")[:300],
                "cited_value": None,
                "verified": bool(pages),
            }
        )
    return evidence


def _gate_for(draft: dict, deal: dict) -> dict:
    pending = draft.get("review_status") == "pending"
    return {
        "pending": pending,
        "actions": list(uw.REVIEW_ACTIONS) if pending else [],
        "review_roles": sorted(uw.DRAFT_REVIEW_ROLES),
        "reason_required_for": (
            ["rejected", "edited"] if draft.get("draft_type") in uw.DRAFT_EDIT_NEEDS_REASON else ["rejected"]
        ),
        # Segregation of duties: whoever submitted the deal may not disposition
        # its agent drafts, whatever their role.
        "barred_reviewer": deal.get("submitted_by_user_id"),
        "editable_fields": (
            list(spreading.TEMPLATE_KEYS)
            if draft.get("draft_type") == "spread"
            else ["classification", "proposed_queue", "missing_documents"]
        ),
    }


# --------------------------------------------------------------------------
# Draft Review workspace
# --------------------------------------------------------------------------


@router.get("/drafts")
def list_review_queue(
    draft_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    """The acceptance queue: every agent draft on the deals the caller may see."""
    deals = {d["id"]: d for d in uw.visible_deals(current_user(authorization))}
    rows = [d for d in uw.store.list("agent_drafts") if d.get("deal_id") in deals]
    if draft_type:
        rows = [d for d in rows if d.get("draft_type") == draft_type]
    if status:
        rows = [d for d in rows if d.get("review_status") == status]
    queue = [_queue_row(draft, deals[draft["deal_id"]]) for draft in rows]
    pending = [row for row in queue if row["review_status"] == "pending"]
    return {
        "drafts": queue,
        "counts": {
            "total": len(queue),
            "pending": len(pending),
            "by_type": {
                artifact: len([row for row in queue if row["draft_type"] == artifact])
                for artifact in sorted({row["draft_type"] for row in queue})
            },
        },
        "spread_ready_deals": [
            {
                "deal_reference": deal["deal_reference"],
                "borrower_name": deal.get("borrower_name"),
                "current_stage": deal.get("current_stage"),
            }
            for deal in deals.values()
            if deal.get("current_stage") in spreading.SPREAD_FROM_STAGES
            and uw.pending_draft(deal["id"], "spread") is None
        ],
        "template_version": spreading.SPREAD_TEMPLATE_VERSION,
    }


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: int, authorization: str | None = Header(default=None)):
    """One draft beside the evidence every figure on it cites."""
    deals = {d["id"]: d for d in uw.visible_deals(current_user(authorization))}
    draft = next((d for d in uw.store.list("agent_drafts") if d["id"] == draft_id), None)
    if draft is None or draft.get("deal_id") not in deals:
        raise HTTPException(status_code=404, detail=f"no draft {draft_id} in your scope")
    deal = deals[draft["deal_id"]]
    view = draft_view(draft)
    return {
        "draft": view,
        "deal": _deal_summary(deal),
        "evidence": _evidence_for(draft, deal),
        "gate": _gate_for(draft, deal),
        "spread_of_record": (
            {
                "line_item_count": len(spreading.spread_of_record(deal["id"])["spread_line_items"]),
                "citation_count": len(spreading.spread_of_record(deal["id"])["citations"]),
            }
            if draft.get("draft_type") == "spread"
            else None
        ),
    }


# --------------------------------------------------------------------------
# The financial spreading agent
# --------------------------------------------------------------------------


@router.post("/deals/{deal_reference}/spread")
def run_spread(
    deal_reference: str,
    req: SpreadRunRequest,
    authorization: str | None = Header(default=None),
):
    """Draft the standard spread from this deal's extracted document locations.

    The agent proposes; the draft is PENDING until a named human accepts it.
    Nothing here writes a spread line item and nothing here computes a ratio.
    """
    deal = _visible_deal(deal_reference, authorization)
    try:
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, spreading.SPREAD_ROLES)
        outcome = spreading.start_spread(deal, actor)
    except uw.DomainError as exc:
        raise fail(exc)
    view = draft_view(outcome["draft"])
    view["created"] = outcome["created"]
    view["deal"] = _deal_summary(deal)
    view["evidence"] = _evidence_for(outcome["draft"], deal)
    view["gate"] = _gate_for(outcome["draft"], deal)
    return view


@router.get("/deals/{deal_reference}/spread")
def get_spread(deal_reference: str, authorization: str | None = Header(default=None)):
    """The accepted spread of record for a deal — line items with the citation
    rows that justify each figure."""
    deal = _visible_deal(deal_reference, authorization)
    record = spreading.spread_of_record(deal["id"])
    draft = next(iter(reversed(uw.drafts_for(deal["id"], "spread"))), None)
    return {
        "deal_reference": deal["deal_reference"],
        "current_stage": deal.get("current_stage"),
        "template_version": spreading.SPREAD_TEMPLATE_VERSION,
        "spread_line_items": record["spread_line_items"],
        "citations": record["citations"],
        "accepted": bool(record["spread_line_items"]),
        "latest_draft": draft_view(draft) if draft else None,
    }
