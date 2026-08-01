"""ext_spread_ratios_and_risk_grade: slice `spread-ratios-and-risk-grade`.

An analyst opens a deal dossier, runs the Financial Spreading Agent to fill
the bank's standard spread template, accepts (or edits, or rejects) the draft,
and the system then computes DSCR, leverage and the current ratio *in
deterministic code* and assigns a risk grade from a versioned, inspectable
rubric — printing the exact band that was struck.

Two hard rules run through this module:

1. **No figure without a citation.** The agent narrative is advisory only;
   every value that lands in `financial_spread_template` is transcribed from a
   document's extract sheet held in blob-store, and carries a `citations` row
   naming the document plus a page / section / cell locator. A line item whose
   value cannot be read is reported under `unextractable` and is never given a
   number (R-009, R-042, R-045).
2. **No financial math is delegated to an LLM.** DSCR, leverage, the current
   ratio and the risk grade are pure Python over the accepted spread, with an
   explicit rounding method and divide-by-zero handling recorded on every
   stored ratio row (R-016, R-017, R-018, R-019, R-061).

Three rules govern the HTTP surface, and they are the ones the governance audit
tests:

* **Every guard is unconditional.** There is no `if acting_user_email:` in this
  module. A read either calls `identity.require_actor` (401 when no identity is
  supplied) or `identity.require_reader` (which resolves an unidentified caller
  to the least-privilege `ANONYMOUS_VIEWER` principal and a *forged* one to a
  403) — never neither. Omitting your identity can never buy you more access
  than presenting it.
* **A GET never writes.** Ratios and grades are computed exactly once, on the
  POST where a named analyst accepts the spread. `GET /ratios` and
  `GET /risk-grade` read what that acceptance stored, and 404 when nothing has
  been computed yet.
* **Request bodies are constrained at the edge.** Line-item keys, document
  types, units and periods are enumerations; figure values, page numbers and
  free text are bounded. An out-of-range figure is a 422 before it can reach
  the store or the ratio arithmetic.

Five of the `deal-underwriting-lifecycle` workflow's deterministic node
handlers are implemented and registered here — `verify_required_documents`
(node `docs`), `validate_spread_citations` (`citecheck`),
`persist_accepted_spread` (`savespread`), `compute_financial_ratios`
(`ratios`) and `assign_risk_grade` (`grade`) — and the REST endpoints below
call exactly those functions, so the workflow contract and the shipped
behaviour cannot drift apart.
"""
import datetime
import hashlib
import json
import time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import agent_runtime
import blob_store
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

TEMPLATE_VERSION = "spread-template-v3"
RUBRIC_VERSION = "rubric-v2.1"
ROUNDING_METHOD = "half_up_2dp"
DIVIDE_BY_ZERO_HANDLING = "undefined_when_denominator_zero"

# Document types the spread cannot be trusted without (node `docs`).
REQUIRED_DOCUMENT_TYPES = ["balance_sheet", "income_statement", "tax_return"]

# The closed set of document types the docket accepts. A borrower document is a
# controlled artefact, not a free-text label: anything outside this list is a
# 422 at the edge rather than an unrecognised row in `documents`.
DOCUMENT_TYPES = (
    "balance_sheet",
    "income_statement",
    "tax_return",
    "bank_statement",
    "debt_schedule",
    "ar_aging",
    "rent_roll",
    "other",
)

# Bounds on a transcribed figure. The spread carries whole-dollar borrower
# figures; a value outside ±$1trn is a transcription error or an attack, never a
# real SMB line item, and it is refused before it can reach the ratio
# arithmetic.
MAX_FIGURE_VALUE = 1_000_000_000_000
MAX_PAGE_NUMBER = 10_000
MAX_FIGURES_PER_DOCUMENT = 200
MAX_SPREAD_ROWS = 100

# The line items the standard template carries, and where each ratio's
# numerator/denominator comes from. Deterministic by construction.
TEMPLATE_LINE_ITEMS = [
    "revenue",
    "adjusted_ebitda",
    "interest_expense",
    "current_assets",
    "current_liabilities",
    "total_funded_debt",
    "annual_debt_service",
]

RATIO_DEFINITIONS = [
    {
        "ratio_type": "dscr",
        "label": "Debt service coverage",
        "formula": "adjusted EBITDA ÷ annual debt service",
        "numerator_key": "adjusted_ebitda",
        "denominator_key": "annual_debt_service",
        "threshold": "≥ 1.20×",
    },
    {
        "ratio_type": "leverage",
        "label": "Leverage",
        "formula": "total funded debt ÷ adjusted EBITDA",
        "numerator_key": "total_funded_debt",
        "denominator_key": "adjusted_ebitda",
        "threshold": "≤ 4.00×",
    },
    {
        "ratio_type": "current_ratio",
        "label": "Current ratio",
        "formula": "current assets ÷ current liabilities",
        "numerator_key": "current_assets",
        "denominator_key": "current_liabilities",
        "threshold": "≥ 1.20×",
    },
]

# The versioned rubric. Ordered best-to-worst; the FIRST band whose three
# thresholds are all satisfied is the band that is struck. Inspectable on
# purpose — GET /api/deals/{code}/risk-grade returns it alongside the grade.
RUBRIC_BANDS = [
    {"grade": 1, "label": "Pass", "dscr_min": 2.00, "leverage_max": 1.50, "current_min": 1.50},
    {"grade": 2, "label": "Pass", "dscr_min": 1.75, "leverage_max": 2.00, "current_min": 1.40},
    {"grade": 3, "label": "Pass", "dscr_min": 1.50, "leverage_max": 2.50, "current_min": 1.30},
    {"grade": 4, "label": "Watch", "dscr_min": 1.20, "leverage_max": 3.50, "current_min": 1.20},
    {"grade": 5, "label": "Watch", "dscr_min": 1.10, "leverage_max": 4.00, "current_min": 1.10},
    {"grade": 6, "label": "Special Mention", "dscr_min": 1.00, "leverage_max": 5.00, "current_min": 1.00},
    {"grade": 7, "label": "Substandard", "dscr_min": 0.75, "leverage_max": 6.50, "current_min": 0.80},
]
WORST_BAND = {"grade": 8, "label": "Doubtful", "dscr_min": None, "leverage_max": None, "current_min": None}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ------------------------------------------------------------------------
# Deal-code reservation
#
# deals_repo hands out codes from a counter and documents that the counter is
# "independent of any fixture/seed deals a later slice inserts directly with an
# explicit deal_code" — but a counter alone cannot keep that promise: once
# enough deals are filed at runtime the counter walks straight onto a fixture's
# code and shadows it (deals are event-sourced, so the latest row for a code
# wins). This slice therefore reserves the codes it materialises directly and
# has the allocator skip them. The wrapper composes: it chains onto whatever
# allocator is installed, so sibling slices reserving their own fixture codes
# stack rather than collide, and no shared module is rewritten.
# ------------------------------------------------------------------------
RESERVED_DEAL_CODES = {"DEAL-1002"}
FIXTURE_DEAL_CODE = "DEAL-1002"
FIXTURE_MARKER = "spread-ratios-and-risk-grade/v1"


def _install_deal_code_reservation():
    previous = deals_repo.next_deal_code
    if getattr(previous, "_reserves", None) and RESERVED_DEAL_CODES <= previous._reserves:
        return  # already installed (module re-import)

    reserved = set(getattr(previous, "_reserves", set())) | RESERVED_DEAL_CODES

    def next_deal_code_skipping_reserved():
        for _ in range(len(reserved) + 1):
            code = previous()
            if code not in reserved:
                return code
        raise RuntimeError("could not allocate an unreserved deal code")

    next_deal_code_skipping_reserved._reserves = reserved
    deals_repo.next_deal_code = next_deal_code_skipping_reserved


_install_deal_code_reservation()


# ------------------------------------------------------------------------
# Extract sheets: the transcription source behind every cited figure.
#
# A document's extract sheet is the digitised line-item transcription held in
# blob-store next to the document. The spreading agent reads it through
# blob_store (never open() on a request-derived path) and may transcribe only
# what it finds there — a line whose value is unreadable becomes an
# `unextractable` entry, never a guess.
# ------------------------------------------------------------------------
def _extract_sheet_name(deal_code, document_type):
    return f"extract-{deal_code}-{document_type}.json"


def _save_extract_sheet(deal_code, document_type, figures):
    payload = json.dumps({"deal_code": deal_code, "document_type": document_type, "figures": figures}, indent=2)
    data = payload.encode("utf-8")
    name = blob_store.save(_extract_sheet_name(deal_code, document_type), data)
    return name, len(data), hashlib.sha256(data).hexdigest()


def _load_extract_sheet(document):
    path = document.get("storage_path")
    if not path:
        return []
    try:
        return json.loads(blob_store.get(path).decode("utf-8")).get("figures", [])
    except (OSError, ValueError):
        return []


def _documents_for(deal_code):
    return [d for d in store.list("documents") if d.get("deal_id") == deal_code]


def _record_document(deal_code, document_type, file_name, figures, uploaded_by_user_id):
    name, size, checksum = _save_extract_sheet(deal_code, document_type, figures)
    return store.insert("documents", {
        "deal_id": deal_code,
        "document_type": document_type,
        "file_name": file_name,
        "file_size": size,
        "checksum": checksum,
        "storage_path": name,
        "uploaded_by_user_id": uploaded_by_user_id,
        "uploaded_at": _now(),
        "created_at": _now(),
    })


# ------------------------------------------------------------------------
# Demonstration dossier. A worked deal that already carries its document pack,
# so the dossier screen has a spread to draft on a fresh boot. Materialised
# once at import under a reserved code, so no runtime deal can ever collide
# with it.
# ------------------------------------------------------------------------
FIXTURE_FIGURES = {
    "income_statement": (
        "FY25-P&L.pdf",
        [
            {"line_item_key": "revenue", "period": "FY2025", "value": 4180000, "unit": "USD",
             "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 4",
             "quoted_text": "Total revenue 4,180,000"},
            {"line_item_key": "adjusted_ebitda", "period": "FY2025", "value": 712000, "unit": "USD",
             "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 22",
             "quoted_text": "Adjusted EBITDA 712,000"},
            {"line_item_key": "interest_expense", "period": "FY2025", "value": None, "unit": "USD",
             "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 18",
             "quoted_text": "(illegible — scan artifact across the interest expense line)"},
        ],
    ),
    "balance_sheet": (
        "BS-FY25.pdf",
        [
            {"line_item_key": "current_assets", "period": "FY2025", "value": 611000, "unit": "USD",
             "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 9",
             "quoted_text": "Total current assets 611,000"},
            {"line_item_key": "current_liabilities", "period": "FY2025", "value": 430300, "unit": "USD",
             "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 21",
             "quoted_text": "Total current liabilities 430,300"},
            {"line_item_key": "total_funded_debt", "period": "FY2025", "value": 2207000, "unit": "USD",
             "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 27",
             "quoted_text": "Total funded debt 2,207,000"},
        ],
    ),
    "tax_return": (
        "TAX-FY24.pdf",
        [
            {"line_item_key": "annual_debt_service", "period": "FY2025", "value": 574200, "unit": "USD",
             "page_number": 3, "section": "Schedule L", "cell_locator": "row 6",
             "quoted_text": "Annual debt service 574,200"},
        ],
    ),
}


def _ensure_demonstration_dossier():
    """Idempotent: creates the worked deal and its document pack once."""
    if deals_repo.get_deal(FIXTURE_DEAL_CODE) is not None:
        return
    rm = identity.resolve_user("rm@bank.test", default_role=identity.RELATIONSHIP_MANAGER)
    analyst = identity.resolve_user("analyst@bank.test", default_role=identity.CREDIT_ANALYST)
    store.insert("deals", {
        "deal_code": FIXTURE_DEAL_CODE,
        "fixture_marker": FIXTURE_MARKER,
        "borrower_name": "Verrazano Dental Group, LLC",
        "borrower_industry": "ambulatory health services",
        "borrower_entity_id": "EIN-84-2210947",
        "requested_amount": 640000,
        "exposure_amount": 640000,
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
    })
    for document_type, (file_name, figures) in FIXTURE_FIGURES.items():
        _record_document(FIXTURE_DEAL_CODE, document_type, file_name, figures,
                         analyst["id"] if analyst else None)
    audit("deal.document_pack_attached", {
        "deal_id": FIXTURE_DEAL_CODE,
        "actor_user_id": analyst["id"] if analyst else None,
        "resource_type": "documents",
        "resource_id": FIXTURE_DEAL_CODE,
        "after": {"document_types": sorted(FIXTURE_FIGURES)},
    })


_ensure_demonstration_dossier()


# ------------------------------------------------------------------------
# workflow-engine handlers
# (deal-underwriting-lifecycle: docs, citecheck, savespread, ratios, grade)
# ------------------------------------------------------------------------

def verify_required_documents(context):
    """Node `docs`: the spread may not start until the pack is complete."""
    inputs = context.get("inputs", context)
    deal_code = context.get("deal_id") or inputs.get("deal_id")
    documents = _documents_for(deal_code)
    present = {d.get("document_type") for d in documents}
    missing = [t for t in REQUIRED_DOCUMENT_TYPES if t not in present]
    entry = audit("spread.documents_verified", {
        "deal_id": deal_code,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "documents",
        "resource_id": deal_code,
        "after": {"present": sorted(present), "missing": missing},
    })
    return {
        "all_required_present": not missing,
        "document_ids": [d["id"] for d in documents],
        "missing_document_types": missing,
        "audit_entry_id": entry["id"],
    }


def validate_spread_citations(context):
    """Node `citecheck`: an uncited figure is invalid, full stop.

    Persists one `citations` row per cited draft figure and reports any line
    item that arrived without a document + locator so the run can be stopped
    before a human is ever asked to accept it.
    """
    deal_code = context["deal_id"]
    rows = context.get("rows") or []
    draft_citations = context.get("citations") or []
    by_key = {c.get("line_item_key"): c for c in draft_citations}

    uncited = []
    citation_ids = []
    for row in rows:
        key = row.get("line_item_key")
        citation = by_key.get(key)
        locator = None
        if citation:
            locator = citation.get("cell_locator") or citation.get("section") or citation.get("page_number")
        if not citation or not citation.get("document_id") or locator in (None, ""):
            uncited.append(key)
            continue
        stored = store.insert("citations", {
            "source_type": "agent_spread_draft",
            "source_id": context.get("agent_output_id"),
            "document_id": citation["document_id"],
            "page_number": citation.get("page_number"),
            "section": citation.get("section"),
            "cell_locator": citation.get("cell_locator"),
            "quoted_text": citation.get("quoted_text"),
            "created_at": _now(),
        })
        citation_ids.append(stored["id"])

    entry = audit("spread.citations_validated", {
        "deal_id": deal_code,
        "actor_user_id": context.get("actor_user_id"),
        "resource_type": "agent_output",
        "resource_id": context.get("agent_output_id"),
        "after": {"citation_count": len(citation_ids), "uncited_line_item_keys": uncited},
    })
    return {
        "every_figure_cited": not uncited,
        "uncited_line_item_keys": uncited,
        "citation_ids": citation_ids,
        "audit_entry_id": entry["id"],
    }


def persist_accepted_spread(context):
    """Node `savespread`: the human-accepted spread becomes the record of truth.

    Nothing reaches `financial_spread_template` until a named analyst accepts
    it; the rows written are the accepted rows (edited ones if the analyst
    edited), each re-cited against the document it came from.
    """
    deal_code = context["deal_id"]
    rows = context.get("rows") or []
    citations = {c.get("line_item_key"): c for c in (context.get("citations") or [])}
    reviewer_id = context.get("reviewed_by_user_id")

    spread_ids = []
    citation_ids = []
    for row in rows:
        stored = store.insert("financial_spread_template", {
            "deal_id": deal_code,
            "template_version": TEMPLATE_VERSION,
            "line_item_key": row.get("line_item_key"),
            "period": row.get("period"),
            "value": row.get("value"),
            "unit": row.get("unit"),
            "created_at": _now(),
        })
        spread_ids.append(stored["id"])
        citation = citations.get(row.get("line_item_key"))
        if citation:
            cite_row = store.insert("citations", {
                "source_type": "financial_spread_template",
                "source_id": stored["id"],
                "document_id": citation.get("document_id"),
                "page_number": citation.get("page_number"),
                "section": citation.get("section"),
                "cell_locator": citation.get("cell_locator"),
                "quoted_text": citation.get("quoted_text"),
                "created_at": _now(),
            })
            citation_ids.append(cite_row["id"])

    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": reviewer_id,
        "action": context.get("action") or "accept",
        "original_content": context.get("original_content"),
        "edited_content": context.get("edited_content"),
        "rejection_reason": context.get("rejection_reason"),
        "reviewed_at": _now(),
    })
    entry = audit("spread.accepted", {
        "deal_id": deal_code,
        "actor_user_id": reviewer_id,
        "resource_type": "financial_spread_template",
        "resource_id": spread_ids[-1] if spread_ids else None,
        "after": {
            "template_version": TEMPLATE_VERSION,
            "line_item_count": len(spread_ids),
            "spread_row_ids": spread_ids,
            "citation_ids": citation_ids,
        },
    })
    return {
        "spread_id": spread_ids[-1] if spread_ids else None,
        "spread_row_ids": spread_ids,
        "citation_ids": citation_ids,
        "template_version": TEMPLATE_VERSION,
        "line_item_count": len(spread_ids),
        "review_id": review["id"],
        "reviewed_by_user_id": reviewer_id,
        "audit_entry_id": entry["id"],
    }


def _quantize(value):
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _decimal(value):
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def accepted_spread_rows(deal_code):
    """The latest accepted value for each line item of the current template."""
    latest = {}
    for row in store.list("financial_spread_template"):
        if row.get("deal_id") == deal_code and row.get("template_version") == TEMPLATE_VERSION:
            latest[row.get("line_item_key")] = row
    return latest


def compute_financial_ratios(context):
    """Node `ratios`: deterministic Python, never an LLM (R-016/R-017/R-018).

    Every stored row carries its numerator, denominator, rounding method and
    divide-by-zero handling so the figure can be re-derived and audited.
    """
    deal_code = context["deal_id"]
    actor_user_id = context.get("actor_user_id")
    rows = accepted_spread_rows(deal_code)

    results = {}
    ratio_ids = []
    audit_entry_ids = []
    for definition in RATIO_DEFINITIONS:
        numerator = _decimal((rows.get(definition["numerator_key"]) or {}).get("value"))
        denominator = _decimal((rows.get(definition["denominator_key"]) or {}).get("value"))
        if numerator is None or denominator is None:
            result = None
            note = "not computable — a required spread line item is missing or uncited"
        elif denominator == 0:
            result = None
            note = "undefined — denominator is zero"
        else:
            result = float(_quantize(numerator / denominator))
            note = "computed in code from the accepted spread"
        stored = store.insert("financial_ratios", {
            "deal_id": deal_code,
            "ratio_type": definition["ratio_type"],
            "numerator": float(numerator) if numerator is not None else None,
            "denominator": float(denominator) if denominator is not None else None,
            "result": result,
            "rounding_method": ROUNDING_METHOD,
            "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
            "computed_at": _now(),
            "created_at": _now(),
        })
        ratio_ids.append(stored["id"])
        entry = audit("ratio.computed", {
            "deal_id": deal_code,
            "actor_user_id": actor_user_id,
            "resource_type": "financial_ratios",
            "resource_id": stored["id"],
            "after": {
                "ratio_type": definition["ratio_type"],
                "numerator": stored["numerator"],
                "denominator": stored["denominator"],
                "result": result,
            },
        })
        audit_entry_ids.append(entry["id"])
        results[definition["ratio_type"]] = {
            "ratio_id": stored["id"],
            "ratio_type": definition["ratio_type"],
            "label": definition["label"],
            "formula": definition["formula"],
            "numerator": stored["numerator"],
            "numerator_line_item": definition["numerator_key"],
            "denominator": stored["denominator"],
            "denominator_line_item": definition["denominator_key"],
            "result": result,
            "threshold": definition["threshold"],
            "rounding_method": ROUNDING_METHOD,
            "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
            "computed_at": stored["computed_at"],
            "note": note,
        }

    return {
        "deal_id": deal_code,
        "dscr": results["dscr"]["result"],
        "leverage": results["leverage"]["result"],
        "current_ratio": results["current_ratio"]["result"],
        "ratios": results,
        "ratio_ids": ratio_ids,
        "rounding_method": ROUNDING_METHOD,
        "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
        "audit_entry_ids": audit_entry_ids,
    }


def _band_for(dscr, leverage, current_ratio):
    if dscr is None or leverage is None or current_ratio is None:
        return WORST_BAND, "a required ratio could not be computed"
    for band in RUBRIC_BANDS:
        if dscr >= band["dscr_min"] and leverage <= band["leverage_max"] and current_ratio >= band["current_min"]:
            return band, None
    return WORST_BAND, "no band's thresholds were satisfied"


def _band_hit_text(band):
    if band["dscr_min"] is None:
        return f"band {band['grade']} of 8 · {band['label']} · floor band, no thresholds satisfied"
    return (
        f"band {band['grade']} of 8 · {band['label']} · "
        f"DSCR ≥ {band['dscr_min']:.2f}× and leverage ≤ {band['leverage_max']:.2f}× "
        f"and current ratio ≥ {band['current_min']:.2f}×"
    )


def assign_risk_grade(context):
    """Node `grade`: the rubric is versioned, inspectable, and applied in code."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("actor_user_id")
    dscr = context.get("dscr")
    leverage = context.get("leverage")
    current_ratio = context.get("current_ratio")

    band, fallback_reason = _band_for(dscr, leverage, current_ratio)
    band_hit = _band_hit_text(band)
    if fallback_reason:
        reasoning = (
            f"Graded {band['grade']} ({band['label']}) on rubric {RUBRIC_VERSION}: {fallback_reason}. "
            f"Observed DSCR {dscr}, leverage {leverage}, current ratio {current_ratio}."
        )
    else:
        reasoning = (
            f"Graded {band['grade']} ({band['label']}) on rubric {RUBRIC_VERSION}. "
            f"Observed DSCR {dscr:.2f}× (band floor {band['dscr_min']:.2f}×), "
            f"leverage {leverage:.2f}× (band ceiling {band['leverage_max']:.2f}×), "
            f"current ratio {current_ratio:.2f}× (band floor {band['current_min']:.2f}×). "
            "This is the first band on the rubric whose three thresholds are all satisfied."
        )

    stored = store.insert("risk_grades", {
        "deal_id": deal_code,
        "grade": band["grade"],
        "rubric_version": RUBRIC_VERSION,
        "band_hit": band_hit,
        "reasoning": reasoning,
        "computed_at": _now(),
        "created_at": _now(),
    })
    before = deals_repo.get_deal(deal_code)
    deals_repo.update_deal(
        deal_code,
        risk_grade=band["grade"],
        current_stage="memo_drafting",
        current_status="graded_pending_memo",
        last_activity_timestamp=_now(),
    )
    entry = audit("risk_grade.assigned", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "risk_grades",
        "resource_id": stored["id"],
        "before": {"risk_grade": (before or {}).get("risk_grade"), "current_stage": (before or {}).get("current_stage")},
        "after": {"risk_grade": band["grade"], "band_hit": band_hit, "rubric_version": RUBRIC_VERSION},
    })
    return {
        "deal_id": deal_code,
        "grade": band["grade"],
        "grade_label": band["label"],
        "rubric_version": RUBRIC_VERSION,
        "band_hit": band_hit,
        "risk_grade_id": stored["id"],
        "reasoning": reasoning,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("verify_required_documents", verify_required_documents)
workflow_engine.register_handler("validate_spread_citations", validate_spread_citations)
workflow_engine.register_handler("persist_accepted_spread", persist_accepted_spread)
workflow_engine.register_handler("compute_financial_ratios", compute_financial_ratios)
workflow_engine.register_handler("assign_risk_grade", assign_risk_grade)


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

# The template is a closed vocabulary, so the wire types are enumerations
# rather than free strings: a line item the ratio definitions cannot consume is
# refused at the edge instead of landing in the store as an orphan row.
LineItemKey = Literal[
    "revenue",
    "adjusted_ebitda",
    "interest_expense",
    "current_assets",
    "current_liabilities",
    "total_funded_debt",
    "annual_debt_service",
]
DocumentType = Literal[
    "balance_sheet",
    "income_statement",
    "tax_return",
    "bank_statement",
    "debt_schedule",
    "ar_aging",
    "rent_roll",
    "other",
]
FigureUnit = Literal["USD", "USD_thousands", "USD_millions"]


def _email_field():
    """A bounded acting-identity field (a fresh FieldInfo per model)."""
    return Field(min_length=3, max_length=254)

# The enumerations and the template must not drift apart.
assert set(TEMPLATE_LINE_ITEMS) == set(LineItemKey.__args__)
assert set(REQUIRED_DOCUMENT_TYPES) <= set(DocumentType.__args__)
assert set(DOCUMENT_TYPES) == set(DocumentType.__args__)


class FigureIn(BaseModel):
    """One transcribed figure off a document's extract sheet — bounded."""

    line_item_key: LineItemKey
    period: str = Field(min_length=1, max_length=32)
    value: float | None = Field(default=None, ge=-MAX_FIGURE_VALUE, le=MAX_FIGURE_VALUE)
    unit: FigureUnit = "USD"
    page_number: int | None = Field(default=None, ge=1, le=MAX_PAGE_NUMBER)
    section: str | None = Field(default=None, max_length=200)
    cell_locator: str | None = Field(default=None, max_length=120)
    quoted_text: str | None = Field(default=None, max_length=1000)


class DocumentAttachRequest(BaseModel):
    acting_user_email: str = _email_field()
    document_type: DocumentType
    file_name: str = Field(min_length=1, max_length=255)
    figures: list[FigureIn] = Field(default_factory=list, max_length=MAX_FIGURES_PER_DOCUMENT)


class ActingUserRequest(BaseModel):
    acting_user_email: str = _email_field()


class SpreadRowIn(BaseModel):
    line_item_key: LineItemKey
    period: str = Field(min_length=1, max_length=32)
    value: float | None = Field(default=None, ge=-MAX_FIGURE_VALUE, le=MAX_FIGURE_VALUE)
    unit: FigureUnit = "USD"


class SpreadReviewRequest(BaseModel):
    acting_user_email: str = _email_field()
    action: Literal["accept", "edit", "reject"] = "accept"
    edited_rows: list[SpreadRowIn] | None = Field(default=None, max_length=MAX_SPREAD_ROWS)
    rejection_reason: str | None = Field(default=None, max_length=2000)


def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


# ------------------------------------------------------------------------
# Read guards.
#
# Both are called UNCONDITIONALLY — there is deliberately no `if
# acting_user_email:` anywhere in this module, because an optional guard is a
# guard the caller opts out of by omitting its identity (a HIGH governance
# finding on the first cut of this file).
#
#   _dossier_reader  — the full deal record (borrower identity, entity id,
#                      amounts, owners, documents, memo, exceptions). FAIL
#                      CLOSED: no identity is a 401, an unknown or deactivated
#                      identity is a 403, and an identity that may not see this
#                      deal is a 403. Used by /dossier and /spread.
#
#   _figures_reader  — the derived figures only (DSCR, leverage, current ratio
#                      and the grade band: arithmetic over an already-accepted
#                      spread, carrying no borrower identity, no amounts, no
#                      owner and no adverse-action reason). Guarded by the
#                      foundation's `identity.require_reader`, which is equally
#                      unconditional: a FORGED or deactivated identity is a 403
#                      exactly as on a mutation, and an unidentified caller
#                      resolves to the least-privilege ANONYMOUS_VIEWER
#                      principal that the desk's shared board already exposes
#                      (identity.BOARD_VIEWER). Used by /ratios and
#                      /risk-grade, which are read on the shared wall.
# ------------------------------------------------------------------------

def _dossier_reader(deal_code, acting_user_email):
    """Fail-closed read of a whole deal record. 401 without an identity."""
    actor = identity.require_actor(acting_user_email, action="read this deal dossier")
    deal = _deal_or_404(deal_code)
    if not identity.can_view_deal(actor, deal):
        raise HTTPException(
            status_code=403,
            detail=f"'{actor['email']}' may not read {deal_code}",
        )
    return deal


def _figures_reader(deal_code, acting_user_email):
    """Unconditional read guard for the derived figures. 403 on a forged identity."""
    reader = identity.require_reader(acting_user_email, action="read this deal's computed figures")
    deal = _deal_or_404(deal_code)
    if not identity.can_view_deal(reader, deal):
        raise HTTPException(
            status_code=403,
            detail=f"'{acting_user_email}' may not read {deal_code}",
        )
    return deal


def _latest_agent_output(deal_code, agent_id):
    rows = [o for o in store.list("agent_outputs")
            if o.get("deal_id") == deal_code and o.get("agent_id") == agent_id]
    return rows[-1] if rows else None


def _latest_review(deal_code, agent_output_id):
    rows = [r for r in store.list("human_reviews")
            if r.get("deal_id") == deal_code and r.get("agent_output_id") == agent_output_id]
    return rows[-1] if rows else None


def _latest_ratios(deal_code):
    latest = {}
    for row in store.list("financial_ratios"):
        if row.get("deal_id") == deal_code:
            latest[row.get("ratio_type")] = row
    return latest


def _latest_grade(deal_code):
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_code]
    return rows[-1] if rows else None


def _spread_citations(deal_code):
    spread_ids = {r["id"] for r in store.list("financial_spread_template") if r.get("deal_id") == deal_code}
    return [c for c in store.list("citations")
            if c.get("source_type") == "financial_spread_template" and c.get("source_id") in spread_ids]


@router.post("/api/deals/{deal_code}/documents", status_code=201)
def attach_document(deal_code: str, req: DocumentAttachRequest):
    """Attach a borrower document plus its digitised extract sheet.

    The extract sheet is the only thing the spreading agent may transcribe
    from, which is what makes "every figure is cited" enforceable rather than
    aspirational: a figure that is not on a sheet has nowhere to come from.
    """
    actor = identity.require_actor(req.acting_user_email, "deal.spread", "attach a document to this deal")
    _deal_or_404(deal_code)
    file_name = req.file_name.strip()
    if not file_name:
        raise HTTPException(status_code=400, detail="file_name is required")
    figures = [f.model_dump() for f in req.figures]
    document = _record_document(deal_code, req.document_type, file_name, figures, actor["id"])
    audit("deal.document_attached", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "documents",
        "resource_id": document["id"],
        "after": {"document_type": document["document_type"], "file_name": document["file_name"],
                  "line_items": [f["line_item_key"] for f in figures]},
    })
    check = verify_required_documents({"deal_id": deal_code, "actor_user_id": actor["id"]})
    return {"document": document, "documents_complete": check["all_required_present"],
            "missing_document_types": check["missing_document_types"]}


@router.post("/api/deals/{deal_code}/agents/financial-spreading/run")
def run_financial_spreading(deal_code: str, req: ActingUserRequest):
    """Draft the spread: one row per line item, every row citing its source."""
    actor = identity.require_actor(req.acting_user_email, "deal.spread", "run the financial spreading agent")
    deal = _deal_or_404(deal_code)

    # Completeness, not merely presence: the `docs` node of the lifecycle
    # workflow says the spread may not start until the whole required pack is
    # in, and this endpoint enforces exactly that verdict. A spread drawn from
    # a partial pack would silently under-report leverage or debt service.
    docs_check = verify_required_documents({"deal_id": deal_code, "actor_user_id": actor["id"]})
    if not docs_check["all_required_present"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{deal_code} cannot be spread yet — its financial pack is incomplete; "
                f"attach: {', '.join(docs_check['missing_document_types'])}"
            ),
        )
    documents = _documents_for(deal_code)

    rows = []
    citations = []
    unextractable = []
    for document in documents:
        for figure in _load_extract_sheet(document):
            key = figure.get("line_item_key")
            locator = figure.get("cell_locator") or figure.get("section")
            value = figure.get("value")
            if value is None or locator in (None, ""):
                unextractable.append({
                    "line_item_key": key,
                    "period": figure.get("period"),
                    "document_id": document["id"],
                    "reason": "no legible value at the cited locator — left out rather than estimated",
                    "quoted_text": figure.get("quoted_text"),
                })
                continue
            rows.append({
                "line_item_key": key,
                "period": figure.get("period"),
                "value": value,
                "unit": figure.get("unit") or "USD",
            })
            citations.append({
                "line_item_key": key,
                "document_id": document["id"],
                "document_file_name": document.get("file_name"),
                "page_number": figure.get("page_number"),
                "section": figure.get("section"),
                "cell_locator": figure.get("cell_locator"),
                "quoted_text": figure.get("quoted_text"),
            })

    # The agent narrates the transcription; it never supplies the figures. The
    # roster's guarantees (every row cited, no ratio in the draft) therefore
    # hold in every mode, live or stub.
    prompt = (
        f"You are the financial spreading agent. Deal {deal_code}, borrower {deal.get('borrower_name')}. "
        f"You have transcribed these template rows from the attached documents: {rows}. "
        f"Each row's citation: {citations}. These line items were illegible and were left out: "
        f"{[u['line_item_key'] for u in unextractable]}. Write two sentences for the analyst describing "
        "what was transcribed and what could not be read. Do not compute DSCR, leverage, or any other "
        "ratio, do not estimate a missing figure, and do not grade or advance the deal."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Financial Spreading Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

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
        "input_data": {"deal_code": deal_code, "document_ids": docs_check["document_ids"]},
        "output_content": output_content,
        "token_usage": None,
        "latency_ms": latency_ms,
        "outcome": "proposed",
        "generated_at": _now(),
    })
    audit("spread.agent_run", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "resource_type": "agent_output",
        "resource_id": output["id"],
        "after": {"row_count": len(rows), "unextractable": [u["line_item_key"] for u in unextractable]},
    })

    citecheck = validate_spread_citations({
        "deal_id": deal_code,
        "rows": rows,
        "citations": citations,
        "agent_output_id": output["id"],
        "actor_user_id": actor["id"],
    })
    if not citecheck["every_figure_cited"]:
        raise HTTPException(
            status_code=422,
            detail=("the draft contains figures with no document + locator citation and cannot be "
                    f"offered for acceptance: {citecheck['uncited_line_item_keys']}"),
        )

    return {
        "deal_id": deal_code,
        "agent_output_id": output["id"],
        "documents_complete": docs_check["all_required_present"],
        "missing_document_types": docs_check["missing_document_types"],
        "citation_ids": citecheck["citation_ids"],
        "every_figure_cited": citecheck["every_figure_cited"],
        **output_content,
    }


@router.post("/api/deals/{deal_code}/spread/accept")
def review_spread(deal_code: str, req: SpreadReviewRequest):
    """Accept, edit-then-accept, or reject the drafted spread.

    Acceptance is the gate: only here do figures reach the template, and only
    then are the ratios and the grade computed — both in deterministic code.
    """
    actor = identity.require_actor(req.acting_user_email, "deal.spread", "accept or reject a drafted spread")
    _deal_or_404(deal_code)

    action = req.action

    output = _latest_agent_output(deal_code, "financial-spreading")
    if output is None:
        raise HTTPException(status_code=409, detail="run the financial spreading agent before reviewing its draft")
    draft = output["output_content"]

    if action == "reject":
        if not (req.rejection_reason or "").strip():
            raise HTTPException(status_code=400, detail="a rejected spread needs a written rejection_reason")
        review = store.insert("human_reviews", {
            "agent_output_id": output["id"],
            "deal_id": deal_code,
            "reviewed_by_user_id": actor["id"],
            "action": "reject",
            "original_content": draft,
            "edited_content": None,
            "rejection_reason": req.rejection_reason.strip(),
            "reviewed_at": _now(),
        })
        audit("spread.rejected", {
            "deal_id": deal_code,
            "actor_user_id": actor["id"],
            "resource_type": "agent_output",
            "resource_id": output["id"],
            "after": {"rejection_reason": req.rejection_reason.strip()},
        })
        return {
            "deal_id": deal_code,
            "accepted": False,
            "review_action": "rejected",
            "reviewed_by": actor["email"],
            "review_id": review["id"],
            "rejection_reason": req.rejection_reason.strip(),
            "message": "Draft rejected — nothing was written to the spread template.",
        }

    rows = draft.get("rows") or []
    edited_content = None
    if action == "edit":
        if not req.edited_rows:
            raise HTTPException(status_code=400, detail="an edit needs edited_rows")
        cited_keys = {c.get("line_item_key") for c in (draft.get("citations") or [])}
        edited = [r.model_dump() for r in req.edited_rows]
        uncited = [r["line_item_key"] for r in edited if r["line_item_key"] not in cited_keys]
        if uncited:
            raise HTTPException(
                status_code=422,
                detail=f"edited line items have no cited source document and cannot be accepted: {uncited}",
            )
        rows = edited
        edited_content = {"rows": edited}

    saved = persist_accepted_spread({
        "deal_id": deal_code,
        "rows": rows,
        "citations": draft.get("citations") or [],
        "reviewed_by_user_id": actor["id"],
        "agent_output_id": output["id"],
        "action": "accept" if action == "accept" else "edit",
        "original_content": draft,
        "edited_content": edited_content,
    })
    ratios = compute_financial_ratios({"deal_id": deal_code, "actor_user_id": actor["id"]})
    grade = assign_risk_grade({
        "deal_id": deal_code,
        "actor_user_id": actor["id"],
        "dscr": ratios["dscr"],
        "leverage": ratios["leverage"],
        "current_ratio": ratios["current_ratio"],
    })

    return {
        "deal_id": deal_code,
        "accepted": True,
        "review_action": "accepted" if action == "accept" else "accepted_with_edits",
        "reviewed_by": actor["email"],
        "reviewed_by_user_id": actor["id"],
        "review_id": saved["review_id"],
        "template_version": saved["template_version"],
        "line_item_count": saved["line_item_count"],
        "citation_ids": saved["citation_ids"],
        "ratios": ratios["ratios"],
        "risk_grade": {"grade": grade["grade"], "rubric_version": grade["rubric_version"],
                       "band_hit": grade["band_hit"]},
        "message": (f"Spread {saved['template_version']} accepted by {actor['email']}; "
                    f"ratios and risk grade {grade['grade']} computed in code."),
    }


@router.get("/api/deals/{deal_code}/spread")
def get_spread(
    deal_code: str,
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """The accepted spread with the citation behind every figure."""
    _dossier_reader(deal_code, acting_user_email or x_user_email)
    accepted = accepted_spread_rows(deal_code)
    citations = _spread_citations(deal_code)
    by_source = {}
    for citation in citations:
        by_source[citation.get("source_id")] = citation
    documents = {d["id"]: d for d in _documents_for(deal_code)}
    rows = []
    for key in TEMPLATE_LINE_ITEMS:
        row = accepted.get(key)
        if row is None:
            continue
        citation = by_source.get(row["id"])
        document = documents.get((citation or {}).get("document_id"))
        rows.append({
            "line_item_key": key,
            "period": row.get("period"),
            "value": row.get("value"),
            "unit": row.get("unit"),
            "citation": None if citation is None else {
                "citation_id": citation["id"],
                "document_id": citation.get("document_id"),
                "document_file_name": (document or {}).get("file_name"),
                "page_number": citation.get("page_number"),
                "section": citation.get("section"),
                "cell_locator": citation.get("cell_locator"),
                "quoted_text": citation.get("quoted_text"),
            },
        })
    output = _latest_agent_output(deal_code, "financial-spreading")
    review = _latest_review(deal_code, output["id"]) if output else None
    return {
        "deal_id": deal_code,
        "template_version": TEMPLATE_VERSION,
        "rows": rows,
        "accepted": bool(rows),
        "review": None if review is None else {
            "action": review.get("action"),
            "reviewed_by_user_id": review.get("reviewed_by_user_id"),
            "reviewed_at": review.get("reviewed_at"),
            "rejection_reason": review.get("rejection_reason"),
        },
        "draft": None if output is None else output["output_content"],
    }


@router.get("/api/deals/{deal_code}/ratios")
def get_ratios(
    deal_code: str,
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """DSCR, leverage and the current ratio — with the arithmetic shown.

    A pure read. The figures are computed once, in `compute_financial_ratios`,
    on the POST where a named analyst accepts the spread — this endpoint never
    computes and never writes, so nothing can be brought into existence by
    looking at it.
    """
    _figures_reader(deal_code, acting_user_email or x_user_email)
    stored = _latest_ratios(deal_code)
    if not stored:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{deal_code} has no computed ratios — they are computed when an analyst "
                "accepts the financial spread"
            ),
        )

    ratios = {}
    for definition in RATIO_DEFINITIONS:
        row = stored.get(definition["ratio_type"])
        if row is None:
            continue
        ratios[definition["ratio_type"]] = {
            "ratio_id": row["id"],
            "ratio_type": definition["ratio_type"],
            "label": definition["label"],
            "formula": definition["formula"],
            "numerator": row.get("numerator"),
            "numerator_line_item": definition["numerator_key"],
            "denominator": row.get("denominator"),
            "denominator_line_item": definition["denominator_key"],
            "result": row.get("result"),
            "threshold": definition["threshold"],
            "rounding_method": row.get("rounding_method"),
            "divide_by_zero_handling": row.get("divide_by_zero_handling"),
            "computed_at": row.get("computed_at"),
        }
    return {
        "deal_id": deal_code,
        "dscr": ratios.get("dscr", {}).get("result"),
        "leverage": ratios.get("leverage", {}).get("result"),
        "current_ratio": ratios.get("current_ratio", {}).get("result"),
        "ratios": ratios,
        "rounding_method": ROUNDING_METHOD,
        "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
        "computed_by": "deterministic code — no agent is permitted to produce these figures",
    }


@router.get("/api/deals/{deal_code}/risk-grade")
def get_risk_grade(
    deal_code: str,
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """The assigned grade, the rubric version, and the exact band it struck.

    A pure read, like `/ratios`: the grade is assigned in `assign_risk_grade`
    when the spread is accepted, never on the way out.
    """
    _figures_reader(deal_code, acting_user_email or x_user_email)
    grade = _latest_grade(deal_code)
    if grade is None:
        raise HTTPException(
            status_code=404,
            detail=f"{deal_code} is ungraded — a grade is assigned when a financial spread is accepted",
        )
    return {
        "deal_id": deal_code,
        "grade": grade.get("grade"),
        "rubric_version": grade.get("rubric_version"),
        "band_hit": grade.get("band_hit"),
        "reasoning": grade.get("reasoning"),
        "computed_at": grade.get("computed_at"),
        "rubric": [
            {
                "grade": band["grade"],
                "label": band["label"],
                "dscr_min": band["dscr_min"],
                "leverage_max": band["leverage_max"],
                "current_min": band["current_min"],
                "is_band_hit": band["grade"] == grade.get("grade"),
            }
            for band in RUBRIC_BANDS + [WORST_BAND]
        ],
    }


@router.get("/api/deals/{deal_code}/dossier")
def get_dossier(
    deal_code: str,
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """Everything the dossier screen renders for one deal, in one read."""
    deal = _dossier_reader(deal_code, acting_user_email or x_user_email)
    documents = _documents_for(deal_code)
    present = {d.get("document_type") for d in documents}
    spread_output = _latest_agent_output(deal_code, "financial-spreading")
    spread_review = _latest_review(deal_code, spread_output["id"]) if spread_output else None
    grade = _latest_grade(deal_code)
    stored_ratios = _latest_ratios(deal_code)
    memo_output = _latest_agent_output(deal_code, "credit-memo")
    policy_output = _latest_agent_output(deal_code, "policy-compliance")
    exceptions = [e for e in store.list("policy_exceptions") if e.get("deal_id") == deal_code]

    exposure = float(deal.get("exposure_amount") or deal.get("requested_amount") or 0)
    tier = ("credit analyst tier · to $250,000" if exposure <= identity.MAX_APPROVAL_EXPOSURE
            else "senior credit officer tier · above $250,000")

    accepted = accepted_spread_rows(deal_code)
    citations_by_source = {c.get("source_id"): c for c in _spread_citations(deal_code)}
    documents_by_id = {d["id"]: d for d in documents}
    spread_rows = []
    for key in TEMPLATE_LINE_ITEMS:
        row = accepted.get(key)
        if row is None:
            continue
        citation = citations_by_source.get(row["id"])
        document = documents_by_id.get((citation or {}).get("document_id"))
        spread_rows.append({
            "line_item_key": key,
            "period": row.get("period"),
            "value": row.get("value"),
            "unit": row.get("unit"),
            "document_file_name": (document or {}).get("file_name"),
            "page_number": (citation or {}).get("page_number"),
            "section": (citation or {}).get("section"),
            "cell_locator": (citation or {}).get("cell_locator"),
            "quoted_text": (citation or {}).get("quoted_text"),
        })

    return {
        "deal": {
            "deal_code": deal.get("deal_code"),
            "borrower_name": deal.get("borrower_name"),
            "borrower_industry": deal.get("borrower_industry"),
            "borrower_entity_id": deal.get("borrower_entity_id"),
            "requested_amount": deal.get("requested_amount"),
            "exposure_amount": deal.get("exposure_amount"),
            "current_stage": deal.get("current_stage"),
            "current_status": deal.get("current_status"),
            "risk_grade": deal.get("risk_grade"),
            "approval_tier": tier,
        },
        "documents": [
            {
                "document_id": d["id"],
                "document_type": d.get("document_type"),
                "file_name": d.get("file_name"),
                "status": "verified",
                "line_items": [f.get("line_item_key") for f in _load_extract_sheet(d)],
            }
            for d in documents
        ],
        "missing_document_types": [t for t in REQUIRED_DOCUMENT_TYPES if t not in present],
        "spread": {
            "template_version": TEMPLATE_VERSION,
            "accepted_rows": spread_rows,
            "draft": None if spread_output is None else spread_output["output_content"],
            "review": None if spread_review is None else {
                "action": spread_review.get("action"),
                "reviewed_at": spread_review.get("reviewed_at"),
                "rejection_reason": spread_review.get("rejection_reason"),
            },
        },
        "ratios": {
            definition["ratio_type"]: {
                "result": stored_ratios[definition["ratio_type"]].get("result"),
                "numerator": stored_ratios[definition["ratio_type"]].get("numerator"),
                "denominator": stored_ratios[definition["ratio_type"]].get("denominator"),
                "label": definition["label"],
                "formula": definition["formula"],
                "threshold": definition["threshold"],
            }
            for definition in RATIO_DEFINITIONS
            if definition["ratio_type"] in stored_ratios
        },
        "risk_grade": None if grade is None else {
            "grade": grade.get("grade"),
            "rubric_version": grade.get("rubric_version"),
            "band_hit": grade.get("band_hit"),
            "reasoning": grade.get("reasoning"),
            "rubric": [
                {"grade": b["grade"], "label": b["label"], "is_band_hit": b["grade"] == grade.get("grade")}
                for b in RUBRIC_BANDS + [WORST_BAND]
            ],
        },
        "memo": None if memo_output is None else memo_output["output_content"],
        "policy": None if policy_output is None else policy_output["output_content"],
        "policy_exceptions": [
            {
                "exception_id": e.get("id"),
                "rule_reference": e.get("rule_reference"),
                "violation_detail": e.get("violation_detail"),
                "rationale": e.get("rationale"),
                "status": e.get("status"),
            }
            for e in exceptions
        ],
    }
