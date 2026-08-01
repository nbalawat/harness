"""Financial spread + the Draft Review workspace (slice 2).

Routes live OUTSIDE /api/ on purpose: main.py ends with a generic
`/api/{table}` catch-all and anything registered under /api/... after it is
dead. Everything here is mounted from its own APIRouter.

The workspace endpoints are draft-type agnostic — the story is "a single Draft
Review workspace that serves every agent draft in the app", so later slices'
memo and policy drafts surface here without a second screen.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query

import spreading
import underwriting as uw
from ext_auth import current_user
from ext_deals import ActorRequest, _draft_view, _fail

router = APIRouter()

#: Which agent produced which draft type — shown on the workspace telemetry.
DRAFT_AGENT = {
    "triage": {"slot": 1, "name": uw.TRIAGE_AGENT_NAME, "short": "Intake triage", "artifact": "Triage classification"},
    "spread": {"slot": 2, "name": spreading.SPREAD_AGENT_NAME, "short": "Spreading", "artifact": "Financial spread"},
}


def _scoped_deal(deal_reference: str, authorization: str | None) -> dict:
    """Resolve a deal, honouring the same row-level scoping as the board.

    Naming a reference must not walk around the scoping /deals applies.
    """
    try:
        deal = uw.require_deal(deal_reference)
    except uw.DomainError as exc:
        raise _fail(exc)
    caller = current_user(authorization)
    if caller and deal["id"] not in {d["id"] for d in uw.visible_deals(caller)}:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_reference}' in your scope")
    return deal


# --------------------------------------------------------------------------
# Financial spreading agent
# --------------------------------------------------------------------------


@router.post("/deals/{deal_reference}/spread")
def run_spread(deal_reference: str, req: ActorRequest, authorization: str | None = Header(default=None)):
    """Draft the financial spread for a deal.

    The agent reads only this deal's extracted document locations and fills the
    standard template, attaching to every figure the document and document
    location it came from. The result is PENDING — it is not deal-of-record
    data until a named human accepts it.
    """
    deal = _scoped_deal(deal_reference, authorization)
    try:
        actor = uw.resolve_actor(current_user(authorization), req.acting_user, spreading.SPREAD_ROLES)
        draft, created = spreading.ensure_spread_draft(deal, actor["username"])
    except uw.DomainError as exc:
        raise _fail(exc)
    view = _draft_view(draft)
    view["created"] = created
    view["deal"] = uw.deal_view(deal)
    view["evidence"] = spreading.evidence_for_draft(deal, draft)
    return view


@router.get("/deals/{deal_reference}/spread")
def get_spread(deal_reference: str, authorization: str | None = Header(default=None)):
    """The spread of record (accepted line items + citations) and the latest draft."""
    deal = _scoped_deal(deal_reference, authorization)
    drafts = uw.drafts_for(deal["id"], "spread")
    return {
        "deal_reference": deal["deal_reference"],
        "current_stage": deal.get("current_stage"),
        "template_version": spreading.SPREAD_TEMPLATE_VERSION,
        "template": [
            {
                "line_item_key": line["line_item_key"],
                "category": line["category"],
                "category_label": spreading.CATEGORY_LABELS[line["category"]],
                "label": line["label"],
                "unit": line["unit"],
            }
            for line in spreading.SPREAD_TEMPLATE
        ],
        "spread_of_record": spreading.spread_of_record(deal),
        "draft": _draft_view(drafts[-1]) if drafts else None,
    }


# --------------------------------------------------------------------------
# Draft Review workspace — one screen for every agent draft in the app
# --------------------------------------------------------------------------


def _queue_row(deal: dict, draft: dict) -> dict:
    content = draft.get("draft_content") or {}
    agent = DRAFT_AGENT.get(draft.get("draft_type"), {})
    run = None
    for row in uw.store.list("agent_runs"):
        if row["id"] == draft.get("agent_run_id"):
            run = row
            break
    return {
        "draft_id": draft["id"],
        "deal_reference": deal.get("deal_reference"),
        "borrower_name": deal.get("borrower_name"),
        "draft_type": draft.get("draft_type"),
        "artifact": agent.get("artifact") or draft.get("draft_type"),
        "agent_slot": agent.get("slot"),
        "agent_name": agent.get("name"),
        "agent_short": agent.get("short"),
        "review_status": draft.get("review_status"),
        "reviewed_by_user_id": draft.get("reviewed_by_user_id"),
        "created_at": draft.get("created_at"),
        "model_id": (run or {}).get("model_id"),
        "prompt_template_version": (run or {}).get("prompt_template_version"),
        "latency_ms": (run or {}).get("latency_ms"),
        "token_cost": (run or {}).get("token_cost"),
        "input_tokens": (run or {}).get("input_tokens"),
        "output_tokens": (run or {}).get("output_tokens"),
        "business_days_idle": uw.business_days_idle(draft.get("created_at")),
        "summary": content.get("rationale", "")[:200],
        "current_stage": deal.get("current_stage"),
        "stage_label": uw.STAGE_LABELS.get(deal.get("current_stage"), deal.get("current_stage")),
    }


@router.get("/reviews")
def review_queue(
    status: str | None = Query(default=None),
    draft_type: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
):
    """The acceptance queue: every agent draft on every deal the caller may see."""
    deals = uw.visible_deals(current_user(authorization))
    rows = []
    for deal in deals:
        for draft in uw.drafts_for(deal["id"]):
            if status and draft.get("review_status") != status:
                continue
            if draft_type and draft.get("draft_type") != draft_type:
                continue
            rows.append(_queue_row(deal, draft))
    rows.sort(key=lambda r: (r["review_status"] != "pending", str(r["created_at"])), reverse=False)
    pending = [r for r in rows if r["review_status"] == "pending"]
    return {
        "drafts": rows,
        "pending_count": len(pending),
        "total_count": len(rows),
        "review_roles": sorted(spreading.SPREAD_ROLES),
    }


@router.get("/reviews/{deal_reference}/{draft_type}/trail")
def review_trail(deal_reference: str, draft_type: str, authorization: str | None = Header(default=None)):
    """The append-only trail entries THIS draft produced.

    Bounded to the draft's own window: from the audit row that recorded its
    creation up to the row that recorded the next draft's creation on the same
    deal. Without that bound a triage draft's trail would also list the spread's
    promotion rows, and the panel would claim credit for another draft's work.
    Read-only over `audit_log`, scoped like every other deal-addressed read, and
    deliberately without `old_values`/`new_values`/`details` — a reviewer's
    written reason belongs on the draft, not in a list widget.
    """
    deal = _scoped_deal(deal_reference, authorization)
    drafts = uw.drafts_for(deal["id"], draft_type)
    if not drafts:
        raise HTTPException(status_code=404, detail=f"no '{draft_type}' draft on deal {deal_reference}")
    draft = drafts[-1]
    rows = [row for row in uw.store.list("audit_log") if row.get("deal_id") == deal["id"]]

    def _creation_row_id(target_draft_id):
        for row in rows:
            if row.get("event_type") == "agent_draft.created" and row.get("entity_id") == target_draft_id:
                return row["id"]
        return None

    start = _creation_row_id(draft["id"])
    # The next draft created on this deal after ours closes our window.
    later = [
        row["id"]
        for row in rows
        if row.get("event_type") == "agent_draft.created" and start is not None and row["id"] > start
    ]
    end = min(later) if later else None

    def _in_window(row):
        if start is None:
            return False
        if row["id"] < start:
            return False
        return end is None or row["id"] < end

    entries = [
        {
            "audit_log_id": row["id"],
            "event_type": row.get("event_type"),
            "action": row.get("action"),
            "actor_user_id": row.get("actor_user_id"),
            "actor_role": row.get("actor_role"),
            "entity_type": row.get("entity_type"),
            "entity_id": row.get("entity_id"),
            "created_at": row.get("created_at"),
        }
        for row in rows
        if _in_window(row)
    ]
    return {
        "deal_reference": deal["deal_reference"],
        "draft_type": draft_type,
        "draft_id": draft["id"],
        "entries": entries[-20:],
        "append_only": True,
    }


@router.get("/reviews/{deal_reference}/{draft_type}")
def review_workspace(deal_reference: str, draft_type: str, authorization: str | None = Header(default=None)):
    """A draft side by side with the evidence each figure cites."""
    deal = _scoped_deal(deal_reference, authorization)
    drafts = uw.drafts_for(deal["id"], draft_type)
    if not drafts:
        raise HTTPException(status_code=404, detail=f"no '{draft_type}' draft on deal {deal_reference}")
    draft = drafts[-1]
    agent = DRAFT_AGENT.get(draft_type, {})
    view = _draft_view(draft)
    return {
        "deal_reference": deal["deal_reference"],
        "deal": uw.deal_view(deal),
        "draft": view,
        "evidence": spreading.evidence_for_draft(deal, draft),
        "agent": {"slot": agent.get("slot"), "name": agent.get("name"), "artifact": agent.get("artifact")},
        "telemetry": view.get("agent_run") or {},
        "spread_of_record": spreading.spread_of_record(deal) if draft_type == "spread" else None,
        "review_actions": list(uw.REVIEW_ACTIONS),
        "gate": {
            "pending": draft.get("review_status") == "pending",
            "reason_required_on": "rejected",
            "blocks_stage": uw.DRAFT_STAGE_ADVANCE.get(draft_type, (None, None))[1],
        },
    }
