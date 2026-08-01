"""The Draft Review workspace and the financial spreading run (slice 2).

One workspace serves every agent draft in the app: the draft beside the
evidence each figure cites, and the accept / edit / reject gate that is the
only door into deal-of-record data. Dispositions themselves keep going through
the slice-1 endpoint (`POST /deals/{ref}/drafts/{type}/review`) so there is
exactly one human gate implementation.

Routes live OUTSIDE /api/ on purpose: main.py ends with a generic /api/{table}
catch-all and anything registered under /api/... after it is dead.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query

import spreading
import underwriting as uw
from db import store
from ext_auth import current_user
from ext_deals import ActorRequest, _draft_view, _fail

router = APIRouter()

#: What each draft type is called on the queue, and which roster agent drafted
#: it. Later slices add their own draft types here.
ARTIFACTS = {
    "triage": {"artifact": "Triage classification", "agent": "1 · Intake triage", "agent_name": uw.TRIAGE_AGENT_NAME},
    "spread": {"artifact": "Financial spread", "agent": "2 · Financial spreading", "agent_name": spreading.SPREAD_AGENT_NAME},
}


#: Everyone who works a draft: the analyst and officer who disposition them and
#: the relationship manager who may follow their own deals. Deny by default —
#: an unnamed caller reads nothing here.
REVIEW_READ_ROLES = frozenset({"credit_analyst", "credit_officer", "credit_committee_chair", "relationship_manager"})


def _reader(authorization: str | None, acting_user: str | None) -> dict:
    """Resolve the named human doing the reading.

    These routes carry drafts, borrower figures and the document excerpts behind
    them, so unlike slice 1's board reads they are deny-by-default: the caller
    signs in, or names themselves the same way every write on this app does
    (`acting_user`), and the rows are scoped to that person (REQ-019).
    """
    return uw.resolve_actor(current_user(authorization), acting_user, REVIEW_READ_ROLES)


def _visible_deal_index(username: str | None) -> dict:
    """Deals the caller is entitled to see, by row id (REQ-019 scoping)."""
    return {deal["id"]: deal for deal in uw.visible_deals(username)}


def _agent_run(run_id) -> dict | None:
    for row in store.list("agent_runs"):
        if row["id"] == run_id:
            return row
    return None


def _telemetry(draft: dict) -> dict:
    run = _agent_run(draft.get("agent_run_id")) or {}
    return {
        "agent_run_id": run.get("id"),
        "agent_name": run.get("agent_name"),
        "agent_type": run.get("agent_type"),
        "model_id": run.get("model_id"),
        "prompt_template_version": run.get("prompt_template_version"),
        "latency_ms": run.get("latency_ms"),
        "input_tokens": run.get("input_tokens"),
        "output_tokens": run.get("output_tokens"),
        "token_cost": run.get("token_cost"),
        "ran_at": run.get("ran_at"),
        "run_stage": run.get("run_stage"),
        "error": run.get("error"),
    }


def _queue_row(draft: dict, deal: dict) -> dict:
    spec = ARTIFACTS.get(draft.get("draft_type"), {"artifact": draft.get("draft_type"), "agent": "—"})
    content = draft.get("draft_content") or {}
    return {
        "id": draft["id"],
        "deal_reference": deal.get("deal_reference"),
        "borrower_name": deal.get("borrower_name"),
        "draft_type": draft.get("draft_type"),
        "artifact": spec["artifact"],
        "agent": spec["agent"],
        "review_status": draft.get("review_status"),
        "reviewed_by_user_id": draft.get("reviewed_by_user_id"),
        "created_at": draft.get("created_at"),
        "age_business_days": uw.business_days_idle(draft.get("created_at")),
        "current_stage": deal.get("current_stage"),
        "stage_label": uw.STAGE_LABELS.get(deal.get("current_stage"), deal.get("current_stage")),
        "approval_tier": deal.get("approval_tier"),
        "source": content.get("source"),
        "telemetry": _telemetry(draft),
    }


def _evidence(draft: dict, deal: dict) -> list[dict]:
    """What the reviewer reads beside the draft: for a spread, the cited
    document location behind every single figure."""
    content = draft.get("draft_content") or {}
    if draft.get("draft_type") == "spread":
        evidence = []
        for item in content.get("line_items") or []:
            citation = item.get("citation") or {}
            evidence.append(
                {
                    "line_item_key": item.get("line_item_key"),
                    "label": item.get("label"),
                    "value": item.get("value"),
                    "unit": item.get("unit"),
                    "period": item.get("period"),
                    "supported": item.get("supported"),
                    "source_type": citation.get("source_type"),
                    "source_reference": citation.get("source_reference"),
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                    "page_number": citation.get("page_number"),
                    "section": citation.get("section"),
                    "excerpt": citation.get("excerpt"),
                    "cited_value": citation.get("cited_value"),
                }
            )
        return evidence

    # Triage draft: the documents (and their extracted locations) the
    # classification and missing-document findings were drawn from.
    documents = uw.documents_for(deal["id"])
    locations = uw.locations_for([d["id"] for d in documents])
    evidence = []
    for document in documents:
        pages = [loc.get("page_number") for loc in locations if loc.get("document_id") == document["id"]]
        first = next((loc for loc in locations if loc.get("document_id") == document["id"]), None)
        evidence.append(
            {
                "label": uw.DOCUMENT_TYPE_LABELS.get(document.get("document_type"), document.get("document_type")),
                "supported": bool(pages),
                "source_type": "document",
                "source_reference": f"{document.get('original_filename')} · {len(pages)} extracted location(s)",
                "document_id": document["id"],
                "document_location_id": first.get("id") if first else None,
                "page_number": max(pages) if pages else None,
                "section": first.get("section") if first else None,
                "excerpt": (first.get("extracted_text") if first else spreading.NOT_SUPPORTED),
                "cited_value": None,
            }
        )
    return evidence


def _draft_detail(draft: dict, deal: dict) -> dict:
    view = _draft_view(draft)
    view["deal"] = uw.deal_view(deal)
    view["telemetry"] = _telemetry(draft)
    view["evidence"] = _evidence(draft, deal)
    view["artifact"] = ARTIFACTS.get(draft.get("draft_type"), {}).get("artifact", draft.get("draft_type"))
    view["agent"] = ARTIFACTS.get(draft.get("draft_type"), {}).get("agent", "—")
    view["editable_fields"] = (
        [{"key": spec["key"], "label": spec["label"], "unit": spec["unit"]} for spec in spreading.SPREAD_TEMPLATE]
        if draft.get("draft_type") == "spread"
        else []
    )
    return view


# --------------------------------------------------------------------------
# The acceptance queue
# --------------------------------------------------------------------------


@router.get("/review/queue")
def review_queue(
    status: str | None = Query(default=None),
    deal_reference: str | None = Query(default=None),
    acting_user: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    """Every agent draft in the app, newest first, scoped to the deals the
    caller may see."""
    try:
        reader = _reader(authorization, acting_user)
    except uw.DomainError as exc:
        raise _fail(exc)
    deals = _visible_deal_index(reader["username"])
    rows = []
    for draft in store.list("agent_drafts"):
        deal = deals.get(draft.get("deal_id"))
        if deal is None:
            continue
        if status and draft.get("review_status") != status:
            continue
        if deal_reference and deal.get("deal_reference") != deal_reference:
            continue
        rows.append(_queue_row(draft, deal))
    rows.sort(key=lambda row: (row["review_status"] != "pending", -(row["id"] or 0)))
    spreadable = [
        {
            "deal_reference": deal.get("deal_reference"),
            "borrower_name": deal.get("borrower_name"),
            "current_stage": deal.get("current_stage"),
            "has_pending_spread": uw.pending_draft(deal["id"], "spread") is not None,
            "has_accepted_spread": bool(spreading.accepted_spread(deal["id"])[0]),
        }
        for deal in deals.values()
        if deal.get("current_stage") in spreading.SPREAD_ENTRY_STAGES and not deal.get("is_closed")
    ]
    return {
        "drafts": rows,
        "pending_count": len([row for row in rows if row["review_status"] == "pending"]),
        "spreadable_deals": spreadable,
        "draft_types": [{"slug": slug, **spec} for slug, spec in ARTIFACTS.items()],
    }


@router.get("/review/drafts/{draft_id}")
def review_draft_detail(
    draft_id: int,
    acting_user: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    try:
        reader = _reader(authorization, acting_user)
    except uw.DomainError as exc:
        raise _fail(exc)
    deals = _visible_deal_index(reader["username"])
    for draft in store.list("agent_drafts"):
        if draft["id"] != draft_id:
            continue
        deal = deals.get(draft.get("deal_id"))
        if deal is None:
            raise HTTPException(status_code=404, detail="no such draft in your scope")
        return _draft_detail(draft, deal)
    raise HTTPException(status_code=404, detail=f"no draft {draft_id}")


# --------------------------------------------------------------------------
# The financial spreading agent
# --------------------------------------------------------------------------


@router.post("/deals/{deal_reference}/spread")
def run_spread(deal_reference: str, req: ActorRequest, authorization: str | None = Header(default=None)):
    """Run the financial spreading agent over the deal's extracted document
    locations and park the filled template as a PENDING draft — every figure
    cited, unsupported lines named as such. Nothing is persisted or advanced
    until a named human accepts it."""
    try:
        # Identity first: an unnamed caller must not be able to learn which deal
        # references exist by reading the 404 off this route.
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, spreading.SPREAD_ROLES)
        deal = uw.require_deal(deal_reference)
        draft, created = spreading.run_spreading_agent(deal, actor)
    except uw.DomainError as exc:
        raise _fail(exc)
    view = _draft_detail(draft, deal)
    view["created"] = created
    view["acting_user"] = actor["username"]
    return view


@router.get("/deals/{deal_reference}/spread")
def accepted_spread(
    deal_reference: str,
    acting_user: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    """The accepted spread of record: line items with the citation behind each
    figure. Empty until a named human accepts the draft."""
    try:
        reader = _reader(authorization, acting_user)
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise _fail(exc)
    if deal["id"] not in _visible_deal_index(reader["username"]):
        raise HTTPException(status_code=404, detail=f"no deal '{deal_reference}' in your scope")
    items, citations = spreading.accepted_spread(deal["id"])
    by_item = {citation.get("spread_line_item_id"): citation for citation in citations}
    return {
        "deal_reference": deal["deal_reference"],
        "current_stage": deal.get("current_stage"),
        "template_version": spreading.SPREAD_TEMPLATE_VERSION,
        "accepted": bool(items),
        "spread_line_items": [dict(item, citation=by_item.get(item["id"])) for item in items],
        "citations": citations,
        "pending_draft": bool(uw.pending_draft(deal["id"], "spread")),
    }
