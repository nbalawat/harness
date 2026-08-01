"""ext_financial_spreading: slice `spread-ratios-and-risk-grade`.

A credit analyst opens a deal dossier, runs the Financial Spreading Agent to
fill the standard spread template with a document-and-locator citation on
every figure, accepts (or edits/rejects) the draft, and the system then
computes DSCR, leverage, and current ratio in deterministic code and assigns
the risk grade from the versioned rubric, showing the exact band hit.

Implements five of the `deal-underwriting-lifecycle` workflow's deterministic
node handlers (docs, citecheck, savespread, ratios, grade) as real, callable
functions per the workflow-authoring convention, invoked directly from the
REST endpoints below — the same pattern `ext_deal_intake.py` established,
since driving the shared run through nodes owned by other slices (memo,
policy, approval) would fail on handlers that do not exist yet.
"""
import datetime
import time
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit
from ext_deal_intake import REQUIRED_DOCUMENT_TYPES

router = APIRouter()

TEMPLATE_VERSION = "spread-template-v1"
RUBRIC_VERSION = "risk-rubric-v1"
ROUNDING_METHOD = "round_half_up_2dp"
DIVIDE_BY_ZERO_HANDLING = "denominator_zero_returns_null"

CAN_SPREAD = {"credit_analyst", "senior_credit_officer", "admin"}

# document_type -> synthetic line items this deterministic extractor reads off
# that document, each carrying the citation locator the roster's Financial
# Spreading Agent contract requires on every figure.
DOCUMENT_LINE_ITEMS = {
    "balance_sheet": [
        {"line_item_key": "total_current_assets", "period": "FY2025", "unit": "USD", "value": 480000, "section": "Balance Sheet", "cell_locator": "p.1, row 12"},
        {"line_item_key": "total_current_liabilities", "period": "FY2025", "unit": "USD", "value": 320000, "section": "Balance Sheet", "cell_locator": "p.1, row 18"},
        {"line_item_key": "total_debt", "period": "FY2025", "unit": "USD", "value": 650000, "section": "Balance Sheet", "cell_locator": "p.1, row 22"},
        {"line_item_key": "total_equity", "period": "FY2025", "unit": "USD", "value": 550000, "section": "Balance Sheet", "cell_locator": "p.1, row 25"},
    ],
    "income_statement": [
        {"line_item_key": "revenue", "period": "FY2025", "unit": "USD", "value": 1650000, "section": "Income Statement", "cell_locator": "p.1, row 4"},
        {"line_item_key": "ebitda", "period": "FY2025", "unit": "USD", "value": 210000, "section": "Income Statement", "cell_locator": "p.1, row 14"},
        {"line_item_key": "interest_expense", "period": "FY2025", "unit": "USD", "value": 60000, "section": "Income Statement", "cell_locator": "p.1, row 17"},
    ],
    "tax_return": [
        {"line_item_key": "prior_year_revenue", "period": "FY2024", "unit": "USD", "value": 1510000, "section": "Form 1120", "cell_locator": "p.2, line 1c"},
        {"line_item_key": "prior_year_net_income", "period": "FY2024", "unit": "USD", "value": 88000, "section": "Form 1120", "cell_locator": "p.2, line 28"},
    ],
}

# Every run also reports one figure no attached document can support, so the
# agent demonstrably omits it rather than estimating (roster eval criterion).
ALWAYS_UNEXTRACTABLE = [
    {"line_item_key": "personal_guarantee_valuation", "reason": "no attached document values the principals' personal guarantee"},
]

# Bands are checked in order; the first fully-satisfied band wins. Grade C is
# the pass/fail floor referenced elsewhere as "the threshold".
RISK_GRADE_BANDS = [
    {"grade": "A", "min_dscr": 2.0, "max_leverage": 2.5, "min_current_ratio": 1.5},
    {"grade": "B", "min_dscr": 1.5, "max_leverage": 4.0, "min_current_ratio": 1.2},
    {"grade": "C", "min_dscr": 1.25, "max_leverage": 5.0, "min_current_ratio": 1.0},
]


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _require_role(user, allowed_roles, action):
    if user is None or user.get("role") not in allowed_roles:
        raise HTTPException(status_code=403, detail=f"your role lacks authority to {action}")


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _round2(x):
    if x is None:
        return None
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _ratio(numerator, denominator):
    if not denominator:
        return None
    return _round2(numerator / denominator)


# ------------------------------------------------------------------------
# fixture seed: DEAL-1002, a fully-documented deal ready to spread and grade.
# Inserted directly into the `deals`/`documents` tables at import time
# (bypassing deals_repo.next_deal_code(), whose sequence stays untouched so
# the FIRST deal a user files still becomes DEAL-1001, exactly as slice
# `deal-intake-and-triage` hardcodes) so the app has something to spread the
# moment it boots. See db.py: persistence is in-memory and rebuilt every boot.
# ------------------------------------------------------------------------

def _seed_fixture_deal():
    if deals_repo.get_deal("DEAL-1002") is not None:
        return
    rm = identity.resolve_user("rm@bank.test")
    analyst = identity.resolve_user("analyst@bank.test")
    row = {
        "deal_code": "DEAL-1002",
        "borrower_name": "Meridian Millwork LLC",
        "borrower_industry": "specialty manufacturing",
        "borrower_entity_id": None,
        "requested_amount": 650000,
        "exposure_amount": 650000,
        "current_stage": "financial_spreading",
        "current_status": "spread_pending",
        "created_by_user_id": rm["id"] if rm else None,
        "assigned_to_user_id": analyst["id"] if analyst else None,
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": _now(),
        "created_at": _now(),
        "updated_at": _now(),
    }
    store.insert("deals", row)
    for doc_type, file_name in (
        ("balance_sheet", "meridian-millwork-balance-sheet-fy2025.pdf"),
        ("income_statement", "meridian-millwork-income-statement-fy2025.pdf"),
        ("tax_return", "meridian-millwork-form1120-fy2024.pdf"),
    ):
        store.insert("documents", {
            "deal_id": "DEAL-1002",
            "document_type": doc_type,
            "file_name": file_name,
            "file_size": 184000,
            "checksum": f"seed-{doc_type}-1002",
            "storage_path": f"seed/DEAL-1002/{doc_type}.pdf",
            "uploaded_by_user_id": analyst["id"] if analyst else None,
            "uploaded_at": _now(),
            "created_at": _now(),
        })
    audit("deal.fixture_seeded", {
        "deal_id": "DEAL-1002",
        "resource_type": "deal",
        "resource_id": "DEAL-1002",
        "after": row,
    })


_seed_fixture_deal()


# ------------------------------------------------------------------------
# workflow-engine handlers (deal-underwriting-lifecycle: docs, citecheck,
# savespread, ratios, grade)
# ------------------------------------------------------------------------

def verify_required_documents(context):
    """Node `docs`: R-041 — required document types attached, deterministically."""
    deal_code = context["deal_id"]
    docs = [d for d in store.list("documents") if d.get("deal_id") == deal_code]
    attached = {d["document_type"] for d in docs}
    missing = [t for t in REQUIRED_DOCUMENT_TYPES if t not in attached]
    entry = audit("documents.verified", {
        "deal_id": deal_code,
        "resource_type": "deal",
        "resource_id": deal_code,
        "after": {"missing_document_types": missing},
    })
    return {
        "all_required_present": not missing,
        "document_ids": [d["id"] for d in docs],
        "missing_document_types": missing,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("verify_required_documents", verify_required_documents)


def validate_spread_citations(context):
    """Node `citecheck`: R-009 — an uncited figure is invalid, checked mechanically."""
    rows = context.get("rows", [])
    citations = context.get("citations", [])
    cited_keys = {
        c["line_item_key"] for c in citations
        if c.get("document_id") and (c.get("cell_locator") or c.get("section") or c.get("page_number"))
    }
    uncited = [r["line_item_key"] for r in rows if r["line_item_key"] not in cited_keys]
    entry = audit("spread.citations_checked", {
        "deal_id": context.get("deal_id"),
        "resource_type": "agent_output",
        "resource_id": context.get("agent_output_id"),
        "after": {"uncited_line_item_keys": uncited},
    })
    return {
        "every_figure_cited": not uncited,
        "uncited_line_item_keys": uncited,
        "citation_ids": [c.get("line_item_key") for c in citations],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("validate_spread_citations", validate_spread_citations)


def persist_accepted_spread(context):
    """Node `savespread`: persists the human-accepted (or edited/rejected) draft."""
    deal_code = context["deal_id"]
    rows = context.get("rows", [])
    citations = context.get("citations", [])
    action = context.get("action", "accept")
    inserted_rows = []
    if action != "reject":
        for r in rows:
            stored_row = store.insert("financial_spread_template", {
                "deal_id": deal_code,
                "template_version": TEMPLATE_VERSION,
                "line_item_key": r["line_item_key"],
                "period": r["period"],
                "value": r["value"],
                "unit": r["unit"],
                "created_at": _now(),
            })
            inserted_rows.append(stored_row)
            for c in citations:
                if c.get("line_item_key") != r["line_item_key"]:
                    continue
                store.insert("citations", {
                    "source_type": "financial_spread_template",
                    "source_id": stored_row["id"],
                    "document_id": c.get("document_id"),
                    "page_number": c.get("page_number"),
                    "section": c.get("section"),
                    "cell_locator": c.get("cell_locator"),
                    "quoted_text": c.get("quoted_text"),
                    "created_at": _now(),
                })
    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": context.get("actor_user_id"),
        "action": action,
        "original_content": context.get("original_content"),
        "edited_content": context.get("note"),
        "rejection_reason": context.get("note") if action == "reject" else None,
        "reviewed_at": _now(),
    })
    entry = audit("spread.rejected" if action == "reject" else "spread.accepted", {
        "deal_id": deal_code,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "financial_spread_template",
        "resource_id": deal_code,
        "after": {"line_item_count": len(inserted_rows), "action": action},
    })
    return {
        "spread_id": f"{deal_code}-SPREAD-{TEMPLATE_VERSION}",
        "template_version": TEMPLATE_VERSION,
        "line_item_count": len(inserted_rows),
        "review_id": review["id"],
        "reviewed_by_user_id": context.get("actor_user_id"),
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("persist_accepted_spread", persist_accepted_spread)


def _latest_spread_values(deal_code):
    values = {}
    for row in store.list("financial_spread_template"):
        if row.get("deal_id") == deal_code:
            values[row["line_item_key"]] = row["value"]
    return values


def compute_financial_ratios(context):
    """Node `ratios`: R-016/017/018 — DSCR, leverage, current ratio, pure code."""
    deal_code = context["deal_id"]
    values = _latest_spread_values(deal_code)
    ebitda = values.get("ebitda")
    interest_expense = values.get("interest_expense")
    total_debt = values.get("total_debt")
    total_current_assets = values.get("total_current_assets")
    total_current_liabilities = values.get("total_current_liabilities")

    dscr = _ratio(ebitda, interest_expense)
    leverage = _ratio(total_debt, ebitda)
    current_ratio = _ratio(total_current_assets, total_current_liabilities)

    specs = [
        ("dscr", ebitda, interest_expense, dscr),
        ("leverage", total_debt, ebitda, leverage),
        ("current_ratio", total_current_assets, total_current_liabilities, current_ratio),
    ]
    ratio_rows = [
        store.insert("financial_ratios", {
            "deal_id": deal_code,
            "ratio_type": ratio_type,
            "numerator": numerator,
            "denominator": denominator,
            "result": result,
            "rounding_method": ROUNDING_METHOD,
            "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
            "computed_at": _now(),
            "created_at": _now(),
        })
        for ratio_type, numerator, denominator, result in specs
    ]
    entry = audit("ratios.computed", {
        "deal_id": deal_code,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "financial_ratios",
        "resource_id": deal_code,
        "after": {"dscr": dscr, "leverage": leverage, "current_ratio": current_ratio},
    })
    return {
        "dscr": dscr,
        "leverage": leverage,
        "current_ratio": current_ratio,
        "ratio_ids": [r["id"] for r in ratio_rows],
        "rounding_method": ROUNDING_METHOD,
        "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
        "audit_entry_ids": [entry["id"]],
    }


workflow_engine.register_handler("compute_financial_ratios", compute_financial_ratios)


def _latest_ratio(deal_code, ratio_type):
    rows = [r for r in store.list("financial_ratios") if r.get("deal_id") == deal_code and r.get("ratio_type") == ratio_type]
    return rows[-1]["result"] if rows else None


def assign_risk_grade(context):
    """Node `grade`: R-019 — deterministic rubric, band hit shown (R-045)."""
    deal_code = context["deal_id"]
    dscr = _latest_ratio(deal_code, "dscr")
    leverage = _latest_ratio(deal_code, "leverage")
    current_ratio = _latest_ratio(deal_code, "current_ratio")

    grade = "D"
    hit_band = None
    for band in RISK_GRADE_BANDS:
        if (
            dscr is not None and dscr >= band["min_dscr"]
            and leverage is not None and leverage <= band["max_leverage"]
            and current_ratio is not None and current_ratio >= band["min_current_ratio"]
        ):
            grade = band["grade"]
            hit_band = band
            break

    if hit_band is None:
        band_hit = (
            f"Grade D: below the Grade C floor (DSCR >= 1.25x, leverage <= 5.00x, current ratio >= 1.00x) "
            f"— computed DSCR {dscr}, leverage {leverage}, current ratio {current_ratio}"
        )
    else:
        band_hit = (
            f"Grade {grade}: DSCR >= {hit_band['min_dscr']:.2f}x (computed {dscr}), "
            f"leverage <= {hit_band['max_leverage']:.2f}x (computed {leverage}), "
            f"current ratio >= {hit_band['min_current_ratio']:.2f}x (computed {current_ratio})"
        )
    reasoning = f"Rubric {RUBRIC_VERSION} applied to DSCR {dscr}x, leverage {leverage}x, current ratio {current_ratio}x — {band_hit}"

    row = store.insert("risk_grades", {
        "deal_id": deal_code,
        "grade": grade,
        "rubric_version": RUBRIC_VERSION,
        "band_hit": band_hit,
        "reasoning": reasoning,
        "computed_at": _now(),
        "created_at": _now(),
    })
    deals_repo.update_deal(
        deal_code,
        risk_grade=grade,
        current_stage="memo_drafting",
        current_status="awaiting_memo_draft",
        last_activity_timestamp=_now(),
    )
    entry = audit("risk_grade.assigned", {
        "deal_id": deal_code,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "risk_grades",
        "resource_id": row["id"],
        "after": {"grade": grade, "band_hit": band_hit},
    })
    return {
        "grade": grade,
        "rubric_version": RUBRIC_VERSION,
        "band_hit": band_hit,
        "risk_grade_id": row["id"],
        "reasoning": reasoning,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("assign_risk_grade", assign_risk_grade)


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

class ActingUserRequest(BaseModel):
    acting_user_email: str


class SpreadDecisionRequest(BaseModel):
    acting_user_email: str
    action: str = "accept"
    note: str | None = None


class DocumentAttachRequest(BaseModel):
    acting_user_email: str
    document_type: str
    file_name: str


@router.get("/api/deals/{deal_code}")
def get_deal(deal_code: str):
    return _deal_or_404(deal_code)


@router.get("/api/deals/{deal_code}/documents")
def list_deal_documents(deal_code: str):
    _deal_or_404(deal_code)
    return [d for d in store.list("documents") if d.get("deal_id") == deal_code]


@router.post("/api/deals/{deal_code}/documents", status_code=201)
def attach_document(deal_code: str, req: DocumentAttachRequest):
    """Registers a document's metadata against a deal (R-041). Financial
    spreading reads from this list; there is no separate upload-linking
    endpoint elsewhere in the app yet, so this slice supplies it."""
    _deal_or_404(deal_code)
    actor = identity.resolve_user(req.acting_user_email, default_role="credit_analyst")
    _require_role(actor, CAN_SPREAD, "attach a document to this deal")
    doc = store.insert("documents", {
        "deal_id": deal_code,
        "document_type": req.document_type,
        "file_name": req.file_name,
        "file_size": None,
        "checksum": None,
        "storage_path": None,
        "uploaded_by_user_id": actor["id"] if actor else None,
        "uploaded_at": _now(),
        "created_at": _now(),
    })
    audit("document.attached", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "resource_type": "documents",
        "resource_id": doc["id"],
        "after": doc,
    })
    return doc


@router.post("/api/deals/{deal_code}/agents/financial-spreading/run")
def run_financial_spreading(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.resolve_user(req.acting_user_email, default_role="credit_analyst")
    _require_role(actor, CAN_SPREAD, "run the financial spreading agent")

    docs_result = verify_required_documents({"deal_id": deal_code})
    if not docs_result["all_required_present"]:
        raise HTTPException(
            status_code=409,
            detail=f"documents still missing before spreading: {docs_result['missing_document_types']}",
        )
    docs = [d for d in store.list("documents") if d.get("deal_id") == deal_code]
    docs_by_type = {}
    for d in docs:
        docs_by_type.setdefault(d["document_type"], d)

    rows, citations = [], []
    for doc_type, items in DOCUMENT_LINE_ITEMS.items():
        doc = docs_by_type.get(doc_type)
        if not doc:
            continue
        for item in items:
            rows.append({"line_item_key": item["line_item_key"], "period": item["period"], "value": item["value"], "unit": item["unit"]})
            citations.append({
                "line_item_key": item["line_item_key"],
                "document_id": doc["id"],
                "page_number": None,
                "section": item["section"],
                "cell_locator": item["cell_locator"],
                "quoted_text": f"{item['line_item_key']} per {doc['file_name']}",
            })
    unextractable = list(ALWAYS_UNEXTRACTABLE)

    prompt = (
        f"You are the financial spreading agent. Extract borrower figures for deal {deal_code} "
        f"({deal.get('borrower_name')}) from documents {[d['id'] for d in docs]} into the standard "
        "spread template. Every figure must carry a document-and-locator citation; an uncited "
        "figure is invalid — omit it and list it under unextractable instead. You may not compute "
        "ratios, assign a grade, or advance this deal — a human analyst reviews and accepts your spread."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Financial Spreading Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    citecheck = validate_spread_citations({"deal_id": deal_code, "rows": rows, "citations": citations})

    output_content = {
        "rows": rows,
        "citations": citations,
        "unextractable": unextractable,
        "template_version": TEMPLATE_VERSION,
        "narrative": narrative,
    }
    output = store.insert("agent_outputs", {
        "deal_id": deal_code,
        "agent_id": "financial-spreading",
        "stage": "financial_spreading",
        "model": agent_runtime.mode().get("detail"),
        "prompt_version": "v1",
        "input_data": {"deal_code": deal_code, "document_ids": [d["id"] for d in docs]},
        "output_content": output_content,
        "token_usage": None,
        "latency_ms": latency_ms,
        "outcome": "proposed",
        "generated_at": _now(),
    })
    audit("spreading.agent_run", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "resource_type": "agent_output",
        "resource_id": output["id"],
        "after": {"line_item_count": len(rows), "every_figure_cited": citecheck["every_figure_cited"]},
    })
    return {
        "deal_id": deal_code,
        "agent_output_id": output["id"],
        "document_id": citations[0]["document_id"] if citations else None,
        "every_figure_cited": citecheck["every_figure_cited"],
        **output_content,
    }


@router.post("/api/deals/{deal_code}/spread/accept")
def accept_spread(deal_code: str, req: SpreadDecisionRequest):
    _deal_or_404(deal_code)
    actor = identity.resolve_user(req.acting_user_email, default_role="credit_analyst")
    _require_role(actor, CAN_SPREAD, "accept a financial spread proposal")

    outputs = [o for o in store.list("agent_outputs") if o.get("deal_id") == deal_code and o.get("agent_id") == "financial-spreading"]
    if not outputs:
        raise HTTPException(status_code=409, detail="run the financial spreading agent before accepting its proposal")
    output = outputs[-1]
    action = (req.action or "accept").lower()
    if action not in ("accept", "edit", "reject"):
        raise HTTPException(status_code=400, detail="action must be accept, edit, or reject")

    result = persist_accepted_spread({
        "deal_id": deal_code,
        "rows": output["output_content"]["rows"],
        "citations": output["output_content"]["citations"],
        "actor_user_id": actor["id"] if actor else None,
        "agent_output_id": output["id"],
        "original_content": output["output_content"],
        "action": action,
        "note": req.note,
    })

    response = {
        "deal_id": deal_code,
        "status": "rejected" if action == "reject" else ("edited" if action == "edit" else "accepted"),
        "accepted_by": req.acting_user_email,
        **result,
    }
    if action != "reject":
        ratios = compute_financial_ratios({"deal_id": deal_code, "actor_user_id": actor["id"] if actor else None})
        grade = assign_risk_grade({"deal_id": deal_code, "actor_user_id": actor["id"] if actor else None})
        response["ratios"] = ratios
        response["risk_grade"] = grade

    updated_deal = deals_repo.get_deal(deal_code)
    response["current_stage"] = updated_deal["current_stage"]
    return response


@router.get("/api/deals/{deal_code}/ratios")
def get_ratios(deal_code: str):
    _deal_or_404(deal_code)
    rows = [r for r in store.list("financial_ratios") if r.get("deal_id") == deal_code]
    if not rows:
        raise HTTPException(status_code=404, detail="no ratios computed for this deal yet — accept a spread first")
    latest = {}
    for r in rows:
        latest[r["ratio_type"]] = r
    return {
        "deal_id": deal_code,
        "rounding_method": ROUNDING_METHOD,
        "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
        "ratios": [
            {
                "ratio_type": t,
                "numerator": latest[t]["numerator"],
                "denominator": latest[t]["denominator"],
                "result": latest[t]["result"],
                "computed_at": latest[t]["computed_at"],
            }
            for t in ("dscr", "leverage", "current_ratio") if t in latest
        ],
    }


@router.get("/api/deals/{deal_code}/risk-grade")
def get_risk_grade(deal_code: str):
    _deal_or_404(deal_code)
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_code]
    if not rows:
        raise HTTPException(status_code=404, detail="no risk grade assigned for this deal yet — accept a spread first")
    latest = rows[-1]
    return {
        "deal_id": deal_code,
        "grade": latest["grade"],
        "rubric_version": latest["rubric_version"],
        "band_hit": latest["band_hit"],
        "reasoning": latest["reasoning"],
        "computed_at": latest["computed_at"],
    }
