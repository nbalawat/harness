"""Financial spreading — slice 2.

The financial spreading agent reads ONLY this deal's extracted document
locations, fills the standard spread template, and attaches to every single
figure a citation naming the document and the document location it came from.
Template lines the documents cannot support carry the exact phrase
"not supported by the record" rather than an estimate.

Composition contract honoured here (see the app-conventions skill):
  * every read/write goes through ``db.store`` (tables from ``models.TABLES``)
  * the only LLM call is ``underwriting.run_agent`` -> ``agent_runtime.respond``
  * the agent PROPOSES; a named human's acceptance is what promotes the spread
    into deal-of-record ``spread_line_items`` + ``citations`` rows
  * no figure is ever computed by the model: a proposed value is admitted only
    if it appears verbatim in the document location the model cited, and the
    fallback derives every figure from the stored record by deterministic code
"""
from __future__ import annotations

import json
import re

import prompts
import underwriting as uw
import workflow_engine
from db import store

SPREAD_PROMPT_NAME = "financial_spread"
SPREAD_PROMPT_VERSION = 1
SPREAD_AGENT_NAME = "Financial Spreading Agent"
SPREAD_TEMPLATE_VERSION = "spread-template@2026.1"

#: Roles allowed to run the spreading agent / review its draft. Deny by default.
SPREAD_ROLES = uw.DRAFT_REVIEW_ROLES

#: Stages at which a spread may be drafted. Before document extraction there is
#: nothing to cite; past risk grading the spread is already deal-of-record.
SPREAD_STAGES = ("document_extraction", "financial_spreading")

NOT_SUPPORTED = "not supported by the record"

MAX_EDIT_REASON = 600
MAX_ABS_VALUE = 1e15


# --------------------------------------------------------------------------
# The standard spread template — the ONLY line items that may be emitted
# --------------------------------------------------------------------------
# `aliases` are the statement captions the deterministic extractor recognises.
# Multi-word aliases may match anywhere in a document location; single-word
# aliases must open the location, so "Sales" can never be harvested out of
# "Cost of Sales".

SPREAD_TEMPLATE = (
    {
        "line_item_key": "revenue",
        "category": "income_statement",
        "label": "Revenue",
        "unit": "usd",
        "aliases": ("Total Revenue", "Revenue", "Net Sales", "Gross Receipts", "Sales"),
    },
    {
        "line_item_key": "cost_of_goods_sold",
        "category": "income_statement",
        "label": "Cost of Goods Sold",
        "unit": "usd",
        "aliases": ("Cost of Goods Sold", "Cost of Sales", "COGS"),
    },
    {
        "line_item_key": "gross_profit",
        "category": "income_statement",
        "label": "Gross Profit",
        "unit": "usd",
        "aliases": ("Gross Profit",),
    },
    {
        "line_item_key": "operating_expenses",
        "category": "income_statement",
        "label": "Operating Expenses",
        "unit": "usd",
        "aliases": ("Total Operating Expenses", "Operating Expenses"),
    },
    {
        "line_item_key": "ebitda",
        "category": "income_statement",
        "label": "EBITDA",
        "unit": "usd",
        "aliases": ("EBITDA",),
    },
    {
        "line_item_key": "depreciation_amortization",
        "category": "income_statement",
        "label": "Depreciation & Amortisation",
        "unit": "usd",
        "aliases": ("Depreciation and Amortization", "Depreciation & Amortization", "Depreciation"),
    },
    {
        "line_item_key": "interest_expense",
        "category": "income_statement",
        "label": "Interest Expense",
        "unit": "usd",
        "aliases": ("Interest Expense",),
    },
    {
        "line_item_key": "net_income",
        "category": "income_statement",
        "label": "Net Income",
        "unit": "usd",
        "aliases": ("Ordinary Business Income", "Net Income", "Net Profit"),
    },
    {
        "line_item_key": "current_assets",
        "category": "balance_sheet",
        "label": "Current Assets",
        "unit": "usd",
        "aliases": ("Total Current Assets", "Current Assets"),
    },
    {
        "line_item_key": "current_liabilities",
        "category": "balance_sheet",
        "label": "Current Liabilities",
        "unit": "usd",
        "aliases": ("Total Current Liabilities", "Current Liabilities"),
    },
    {
        "line_item_key": "total_debt",
        "category": "balance_sheet",
        "label": "Total Debt",
        "unit": "usd",
        "aliases": ("Total Funded Debt", "Total Debt", "Funded Debt"),
    },
    {
        "line_item_key": "tangible_net_worth",
        "category": "balance_sheet",
        "label": "Tangible Net Worth",
        "unit": "usd",
        "aliases": ("Tangible Net Worth",),
    },
    {
        "line_item_key": "annual_debt_service",
        "category": "debt_service",
        "label": "Annual Debt Service",
        "unit": "usd",
        "aliases": ("Annual Principal and Interest", "Annual Debt Service", "Debt Service"),
    },
    {
        "line_item_key": "owner_distributions",
        "category": "debt_service",
        "label": "Owner Distributions",
        "unit": "usd",
        "aliases": ("Shareholder Distributions", "Owner Distributions", "Distributions"),
    },
)

TEMPLATE_BY_KEY = {line["line_item_key"]: line for line in SPREAD_TEMPLATE}
TEMPLATE_KEYS = tuple(TEMPLATE_BY_KEY)

CATEGORY_LABELS = {
    "income_statement": "Income Statement",
    "balance_sheet": "Balance Sheet",
    "debt_service": "Debt Service",
}


# --------------------------------------------------------------------------
# Number / period parsing — deterministic, unit-tested
# --------------------------------------------------------------------------

_NUMBER = r"\(?-?\$?\s?\d[\d,]*(?:\.\d+)?\)?"
_NUMBER_RE = re.compile(_NUMBER)
_PERIOD_RE = re.compile(r"\b(?:FY|fiscal\s+year|tax\s+year)\s*[-:]?\s*(\d{4})\b", re.IGNORECASE)


def parse_number(token: str) -> float | None:
    """'(1,234.50)' -> -1234.5 ; '$12,400,000' -> 12400000.0 ; junk -> None."""
    text = str(token or "").strip()
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    if not cleaned or cleaned in ("-", ".", "-."):
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    if value != value or abs(value) > MAX_ABS_VALUE:  # NaN / absurd magnitude
        return None
    return -abs(value) if negative else value


_INFINITIES = (float("inf"), float("-inf"))


def coerce_money(raw) -> float | None:
    """Parse a money value supplied by a model OR by a human edit.

    ONE gate for both, so the two paths cannot drift: a bool, a NaN, an
    infinity, an int literal big enough to overflow float(), or anything past
    the app's magnitude bound is refused rather than written to the record.
    """
    try:
        if isinstance(raw, str):
            value = parse_number(raw)
        elif isinstance(raw, bool) or not isinstance(raw, (int, float)):
            value = None
        else:
            value = float(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if value is None or value != value or value in _INFINITIES or abs(value) > MAX_ABS_VALUE:
        return None
    return value


def numbers_in(text: str) -> list[float]:
    values = []
    for token in _NUMBER_RE.findall(str(text or "")):
        parsed = parse_number(token)
        if parsed is not None:
            values.append(parsed)
    return values


def value_supported_by(text: str, value: float) -> bool:
    """Is `value` literally stated in this document location?

    This is what keeps money out of the model's hands: a figure the agent
    proposes is admitted only when the location it cited actually says it.
    """
    return any(abs(candidate - float(value)) < 0.005 for candidate in numbers_in(text))


def period_of(texts) -> str | None:
    for text in texts:
        match = _PERIOD_RE.search(str(text or ""))
        if match:
            return "FY" + match.group(1)
    return None


def _alias_pattern(alias: str, anchored: bool) -> re.Pattern:
    words = r"\s+".join(re.escape(word) for word in alias.split())
    prefix = r"^\s*" if anchored else r"(?:^|[^A-Za-z])"
    return re.compile(prefix + words + r"\b\s*[:\-–]?\s*(?:of\s+)?(" + _NUMBER + r")", re.IGNORECASE)


def find_line_value(line: dict, locations: list[dict]) -> dict | None:
    """First location whose caption matches this template line, with its value.

    Two passes so a short caption can never be harvested out of a longer one:
    pass 1 requires the caption to open the location; pass 2 allows it mid-line
    but only for unambiguous multi-word captions.
    """
    for anchored in (True, False):
        for alias in line["aliases"]:
            if not anchored and len(alias.split()) < 2:
                continue
            pattern = _alias_pattern(alias, anchored)
            for location in locations:
                match = pattern.search(str(location.get("extracted_text") or ""))
                if not match:
                    continue
                value = parse_number(match.group(1))
                if value is None:
                    continue
                return {"value": value, "location": location, "matched_caption": alias, "cited_text": match.group(1).strip()}
    return None


# --------------------------------------------------------------------------
# Evidence the agent is allowed to read
# --------------------------------------------------------------------------


def spread_facts(deal: dict) -> dict:
    """Everything the spread prompt and its run record are built from.

    Only this deal's stored documents and their extracted locations — nothing
    from another deal, and nothing outside the record.
    """
    document_rows = uw.documents_for(deal["id"])
    documents = {row["id"]: row for row in document_rows}
    locations = uw.locations_for(list(documents))
    by_document: dict = {}
    for location in locations:
        by_document.setdefault(location["document_id"], []).append(location)
    return {
        "document_rows": document_rows,
        "documents": documents,
        "locations": locations,
        "locations_by_document": by_document,
        "location_ids": [loc["id"] for loc in locations],
        "period": period_of([loc.get("extracted_text") for loc in locations]),
    }


def document_period(facts: dict, document_id) -> str | None:
    texts = [loc.get("extracted_text") for loc in facts["locations_by_document"].get(document_id, [])]
    return period_of(texts) or facts["period"]


def _citation_for(facts: dict, location: dict, cited_value: str) -> dict:
    document = facts["documents"].get(location["document_id"], {})
    filename = document.get("original_filename") or f"document {location['document_id']}"
    section = location.get("section") or "body"
    page = location.get("page_number")
    return {
        "source_type": "document_location",
        "document_id": location["document_id"],
        "document_location_id": location["id"],
        "document_filename": filename,
        "document_type": document.get("document_type"),
        "page_number": page,
        "section": section,
        "cited_value": str(cited_value),
        "excerpt": str(location.get("extracted_text") or "")[:400],
        "source_reference": f"{filename} · p.{page} · {section}",
    }


def uncited_count(lines) -> int:
    """Figures on the spread that name no source at all.

    ONE definition, used by the agent path, the human-edit path and the
    promotion record — the roster holds this agent to zero. A figure is cited
    when it names the document location it was read from, or when a named human
    corrected it at acceptance (their own citation, not the agent's).
    """
    uncited = 0
    for line in lines or []:
        if not line.get("supported"):
            continue
        citation = line.get("citation") or {}
        if citation.get("document_location_id"):
            continue
        if citation.get("source_type") == "human_correction":
            continue
        uncited += 1
    return uncited


def _unsupported_line(line: dict, period: str | None) -> dict:
    return {
        "line_item_key": line["line_item_key"],
        "category": line["category"],
        "category_label": CATEGORY_LABELS.get(line["category"], line["category"]),
        "label": line["label"],
        "unit": line["unit"],
        "period": period,
        "value": None,
        "display_value": NOT_SUPPORTED,
        "supported": False,
        "citation": {"source_type": "none", "source_reference": NOT_SUPPORTED, "cited_value": NOT_SUPPORTED},
    }


def _supported_line(line: dict, value: float, citation: dict, period: str | None) -> dict:
    return {
        "line_item_key": line["line_item_key"],
        "category": line["category"],
        "category_label": CATEGORY_LABELS.get(line["category"], line["category"]),
        "label": line["label"],
        "unit": line["unit"],
        "period": period,
        "value": round(float(value), 2),
        "display_value": f"{float(value):,.0f}",
        "supported": True,
        "citation": citation,
    }


# --------------------------------------------------------------------------
# Deterministic derivation from the record (the fallback, and the yardstick)
# --------------------------------------------------------------------------


def derive_spread(deal: dict, facts: dict) -> dict:
    lines = []
    for line in SPREAD_TEMPLATE:
        hit = find_line_value(line, facts["locations"])
        if hit is None:
            lines.append(_unsupported_line(line, facts["period"]))
            continue
        location = hit["location"]
        citation = _citation_for(facts, location, hit["cited_text"])
        citation["matched_caption"] = hit["matched_caption"]
        lines.append(_supported_line(line, hit["value"], citation, document_period(facts, location["document_id"])))
    return {"line_items": lines}


# --------------------------------------------------------------------------
# The agent's structured proposal — admitted only if every figure validates
# --------------------------------------------------------------------------


def parse_spread_reply(reply: str, facts: dict) -> dict | None:
    """Accept the model's spread only if EVERY figure is cited and the cited
    location actually states it. One bad figure invalidates the proposal — a
    spread is not a place for partial credit.
    """
    locations = {loc["id"]: loc for loc in facts["locations"]}
    if not locations:
        return None
    for blob in uw._json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        items = parsed.get("line_items")
        if not isinstance(items, list) or not items:
            continue
        proposal: dict = {}
        valid = True
        # A live model can return anything at all — a list where an id belongs,
        # say. A malformed proposal is refused (and the deterministic extractor
        # takes over); it never becomes a 500 on the analyst's screen.
        try:
            valid, proposal = _read_proposal(items, locations)
        except (TypeError, ValueError, OverflowError):
            continue
        if valid and any(proposal.values()):
            return proposal
    return None


def _read_proposal(items, locations) -> tuple[bool, dict]:
    """Validate the model's line items. Returns (valid, proposal).

    One invalid figure invalidates the whole proposal — a spread is not a place
    for partial credit.
    """
    proposal: dict = {}
    for item in items:
        if not isinstance(item, dict):
            return False, proposal
        key = item.get("line_item_key")
        if not isinstance(key, str) or key not in TEMPLATE_BY_KEY or key in proposal:
            return False, proposal
        raw_value = item.get("value")
        if raw_value is None or (isinstance(raw_value, str) and NOT_SUPPORTED in raw_value.lower()):
            proposal[key] = None
            continue
        value = coerce_money(raw_value)
        location_id = item.get("document_location_id")
        location = locations.get(location_id) if isinstance(location_id, (int, str)) else None
        if value is None or location is None:
            return False, proposal  # an uncited or unusable figure is invalid output
        document_id = item.get("document_id")
        if document_id is not None and document_id != location["document_id"]:
            return False, proposal
        if not value_supported_by(location.get("extracted_text"), value):
            return False, proposal  # the cited location does not state this figure
        # Checking the digits is not enough: without this, the model could point
        # the Revenue line at the "Cost of Goods Sold 7,300,000" location, or at
        # the year in a statement header, and the number would validate. The
        # cited location must itself READ as this template line under the same
        # anchored caption rules the deterministic extractor uses, and state the
        # same figure. The model may choose WHICH evidence to cite; it may not
        # decide what a number means.
        confirmed = find_line_value(TEMPLATE_BY_KEY[key], [location])
        if confirmed is None or abs(confirmed["value"] - value) >= 0.005:
            return False, proposal
        proposal[key] = {"value": value, "location": location}
    return True, proposal


def _content_from_proposal(deal: dict, facts: dict, proposal: dict) -> dict:
    lines = []
    for line in SPREAD_TEMPLATE:
        hit = proposal.get(line["line_item_key"])
        if not hit:
            lines.append(_unsupported_line(line, facts["period"]))
            continue
        location = hit["location"]
        citation = _citation_for(facts, location, f"{hit['value']:,.0f}")
        lines.append(_supported_line(line, hit["value"], citation, document_period(facts, location["document_id"])))
    return {"line_items": lines}


def build_spread_content(deal: dict, facts: dict, reply: str) -> dict:
    # The deterministic derivation is computed either way — it is the fallback
    # AND the yardstick. Reconciling against it is what stops the model from
    # silently SUPPRESSING a template line the documents plainly support by
    # returning null for it.
    from_record = {line["line_item_key"]: line for line in derive_spread(deal, facts)["line_items"]}
    proposal = parse_spread_reply(reply, facts)
    if proposal is None:
        lines = [from_record[line["line_item_key"]] for line in SPREAD_TEMPLATE]
        source = "deterministic-fallback"
    else:
        from_agent = {
            line["line_item_key"]: line for line in _content_from_proposal(deal, facts, proposal)["line_items"]
        }
        lines = []
        recovered = 0
        for template_line in SPREAD_TEMPLATE:
            key = template_line["line_item_key"]
            if from_agent[key]["supported"]:
                lines.append(from_agent[key])
                continue
            lines.append(from_record[key])
            if from_record[key]["supported"]:
                recovered += 1
        source = "agent+record" if recovered else "agent"
    supported = [line for line in lines if line["supported"]]
    unsupported = [line["line_item_key"] for line in lines if not line["supported"]]
    citations = [
        {
            "line_item_key": line["line_item_key"],
            "label": line["label"],
            "value": line["value"],
            **line["citation"],
        }
        for line in supported
    ]
    if supported:
        rationale = (
            f"{len(supported)} of {len(lines)} standard template lines are supported by "
            f"{len(facts['document_rows'])} document(s) across {len(facts['locations'])} extracted locations; "
            f"every figure carries the document and document location it was read from."
        )
        if unsupported:
            rationale += (
                " " + ", ".join(TEMPLATE_BY_KEY[key]["label"] for key in unsupported)
                + f": {NOT_SUPPORTED}."
            )
    else:
        rationale = (
            f"No template line could be read from the record for this deal — {NOT_SUPPORTED}. "
            "Collect the borrower financial statements before the spread can be drafted."
        )
    return {
        "template_version": SPREAD_TEMPLATE_VERSION,
        "period": facts["period"],
        "spread_line_items": lines,
        "citations": citations,
        "unsupported_lines": unsupported,
        "supported_line_count": len(supported),
        "template_line_count": len(lines),
        # Contract the roster holds this agent to: zero uncited figures.
        "uncited_value_count": uncited_count(lines),
        "documents_on_file": len(facts["document_rows"]),
        "document_location_count": len(facts["locations"]),
        "rationale": rationale,
        "source": source,
    }


# --------------------------------------------------------------------------
# The prompt (versioned through the prompt-registry module)
# --------------------------------------------------------------------------

SPREAD_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name
Facility type: $facility_type
Requested amount (USD): $requested_amount

You may use NOTHING except the extracted document locations listed below.

$location_catalog

Standard spread template — emit these line_item_key values and no others:
$template_lines

Return ONLY a JSON object shaped exactly like this and nothing else:
{"line_items": [
  {"line_item_key": "<template key>",
   "value": <the number exactly as stated in the cited location, or null>,
   "document_id": <the document id of the location you read it from>,
   "document_location_id": <the document location id you read it from>}
]}

Rules:
- Every numeric value MUST carry both a document_id and a document_location_id
  drawn from the catalogue above; an uncited figure is invalid output.
- Never carry a number over from memory or from another deal, and never adjust,
  total, or restate a figure — copy it exactly as the location states it.
- Where the documents do not support a template line, emit "value": null for it;
  that line will be recorded as "$not_supported".
- Do NOT compute DSCR, leverage, or the current ratio. Those are calculated by
  the system from the accepted spread, not by you."""

prompts.register(SPREAD_PROMPT_NAME, SPREAD_PROMPT_TEXT, version=SPREAD_PROMPT_VERSION)


def build_spread_prompt(deal: dict, facts: dict) -> str:
    catalog = (
        "\n".join(
            f"- location {loc['id']} (document {loc['document_id']}, page {loc.get('page_number')}, "
            f"section {loc.get('section')}): {str(loc.get('extracted_text') or '')[:240]}"
            for loc in facts["locations"][:200]
        )
        or "- none extracted for this deal"
    )
    template_lines = "\n".join(
        f"- {line['line_item_key']} ({CATEGORY_LABELS[line['category']]} · {line['label']}, {line['unit']})"
        for line in SPREAD_TEMPLATE
    )
    return prompts.render(
        SPREAD_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        facility_type=deal["facility_type"],
        requested_amount=f"{deal['requested_amount']:,.2f}",
        location_catalog=catalog,
        template_lines=template_lines,
        not_supported=NOT_SUPPORTED,
    )


def spread_run_inputs(deal: dict, facts: dict) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": sorted(facts["documents"]),
        "document_location_ids": facts["location_ids"],
        "template_version": SPREAD_TEMPLATE_VERSION,
        "template_keys": list(TEMPLATE_KEYS),
    }


# --------------------------------------------------------------------------
# Drafting the spread — the agent proposes, a human disposes
# --------------------------------------------------------------------------


def _park(deal: dict, content: dict, agent_run_id, actor_user_id: str) -> dict:
    return uw.park_draft(
        deal,
        "spread",
        content,
        agent_run_id,
        actor_user_id,
        action="financial spread draft created (pending human acceptance)",
    )


def adopt_workflow_spread(deal: dict, actor_user_id: str) -> dict | None:
    """Adopt the approved process's OWN spread_financials output as the draft.

    The `deal-underwriting` run already executed the spreading agent node when
    the triage acceptance resumed it. Re-prompting here would double the cost
    and — worse — mean the spread a human reviews is not the one the process
    produced. The node's reply is adopted and recorded as the agent run.
    """
    run_id = deal.get("workflow_run_id")
    if not run_id or uw.drafts_for(deal["id"], "spread"):
        return None
    try:
        context = workflow_engine.state(run_id).get("context") or {}
    except Exception:
        return None
    reply = (context.get("spread_financials") or {}).get("reply")
    if not reply:
        return None

    facts = spread_facts(deal)
    model = uw.model_id()
    in_tokens = uw._estimate_tokens(build_spread_prompt(deal, facts))
    out_tokens = uw._estimate_tokens(reply)
    cost_row = uw.costmeter.record(model, in_tokens, out_tokens)
    run = store.insert(
        "agent_runs",
        {
            "input_tokens": in_tokens,
            "output_tokens": out_tokens,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "agent_type": "financial_spreading",
            "agent_name": SPREAD_AGENT_NAME,
            "run_stage": "financial_spreading",
            "model_id": model,
            "prompt_template_version": uw.prompt_version(SPREAD_PROMPT_NAME),
            "inputs": spread_run_inputs(deal, facts) | {"workflow_run_id": run_id, "workflow_node": "spread_financials"},
            "raw_output": uw.pii.redact(reply)[:4000],
            # wall clock of the workflow tick that executed this agent node —
            # the engine exposes no per-node timing (same convention as slice 1)
            "latency_ms": uw.last_tick_ms(run_id),
            "token_cost": cost_row["usd"],
            "ran_at": uw.now_iso(),
            "error": None,
        },
    )
    uw._log("agent.run", agent="financial_spreading", deal_reference=deal["deal_reference"], agent_run_id=run["id"], source="workflow")
    return _park(deal, build_spread_content(deal, facts, reply), run["id"], actor_user_id)


def build_spread_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the spreading agent directly and park the result PENDING.

    Used for a re-draft after a rejection, or when there is no unconsumed
    workflow output to adopt. Nothing here writes deal-of-record data.
    """
    facts = spread_facts(deal)
    outcome = uw.run_agent(
        agent_name=SPREAD_AGENT_NAME,
        prompt=build_spread_prompt(deal, facts),
        deal=deal,
        agent_type="financial_spreading",
        run_stage="financial_spreading",
        prompt_name=SPREAD_PROMPT_NAME,
        inputs=spread_run_inputs(deal, facts),
    )
    return _park(deal, build_spread_content(deal, facts, outcome["reply"]), outcome["run"]["id"], actor_user_id)


def triage_accepted(deal: dict) -> bool:
    return any(row.get("review_status") in ("accepted", "edited") for row in uw.drafts_for(deal["id"], "triage"))


def ensure_spread_draft(deal: dict, actor_user_id: str) -> tuple[dict, bool]:
    """Materialise the PENDING spread draft for this deal. Idempotent."""
    if not triage_accepted(deal):
        raise uw.DomainError(
            409,
            f"the intake triage draft on {deal['deal_reference']} must be accepted by a named human "
            "before the financial spread can be drafted",
        )
    if deal.get("current_stage") not in SPREAD_STAGES:
        raise uw.DomainError(
            409,
            f"deal {deal['deal_reference']} is at stage '{deal.get('current_stage')}'; the financial "
            f"spread is drafted at {' or '.join(SPREAD_STAGES)}",
        )
    existing = uw.pending_draft(deal["id"], "spread")
    if existing is not None:
        return existing, False

    # Spreading has begun — that is a real stage move, recorded as a transition.
    if deal.get("current_stage") == "document_extraction":
        uw.record_transition(deal, "financial_spreading", actor_user_id, reason="financial spreading started")

    draft = adopt_workflow_spread(deal, actor_user_id) or build_spread_draft(deal, actor_user_id)
    return draft, True


# --------------------------------------------------------------------------
# Human edits — a corrected figure is the human's, and it says so
# --------------------------------------------------------------------------


def apply_spread_edits(content: dict, edits: dict) -> dict:
    """Edit-and-accept on a spread: correct or withdraw individual figures.

    edits = {"line_items": {"<template key>": {"value": <number|null>,
                                               "note": "<why>"}}}
    A human-corrected figure is cited to the named human, never left wearing
    the agent's citation.
    """
    raw = (edits or {}).get("line_items")
    if not isinstance(raw, dict) or not raw:
        raise uw.DomainError(400, "an edited spread must supply edits.line_items keyed by template line")
    lines = {line["line_item_key"]: line for line in content.get("spread_line_items") or []}
    applied: dict = {}
    for key, patch in raw.items():
        line = lines.get(key)
        if line is None:
            raise uw.DomainError(400, f"'{key}' is not a line on {SPREAD_TEMPLATE_VERSION}")
        if not isinstance(patch, dict):
            raise uw.DomainError(400, f"edit for '{key}' must be an object with a 'value'")
        note = str(patch.get("note") or "").strip()[:MAX_EDIT_REASON]
        if "value" not in patch:
            raise uw.DomainError(400, f"edit for '{key}' must carry a 'value' (null withdraws the figure)")
        raw_value = patch["value"]
        before = line.get("value")
        if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
            template = TEMPLATE_BY_KEY[key]
            lines[key] = _unsupported_line(template, line.get("period"))
            lines[key]["citation"]["source_reference"] = NOT_SUPPORTED + (f" — {note}" if note else "")
        else:
            value = coerce_money(raw_value)
            if value is None:
                raise uw.DomainError(
                    400,
                    f"edit for '{key}' must be a finite number within {MAX_ABS_VALUE:,.0f}, or null to withdraw it",
                )
            line["value"] = round(value, 2)
            line["display_value"] = f"{value:,.0f}"
            line["supported"] = True
            line["citation"] = {
                "source_type": "human_correction",
                "document_id": None,
                "document_location_id": None,
                "cited_value": f"{value:,.0f}",
                "source_reference": "corrected by the reviewing human at acceptance",
                "excerpt": note or "no note recorded",
            }
        applied[key] = {"from": before, "to": lines[key].get("value"), "note": note or None}

    ordered = [lines[line["line_item_key"]] for line in SPREAD_TEMPLATE if line["line_item_key"] in lines]
    supported = [line for line in ordered if line["supported"]]
    content["spread_line_items"] = ordered
    content["unsupported_lines"] = [line["line_item_key"] for line in ordered if not line["supported"]]
    content["supported_line_count"] = len(supported)
    content["citations"] = [
        {"line_item_key": line["line_item_key"], "label": line["label"], "value": line["value"], **line["citation"]}
        for line in supported
    ]
    content["uncited_value_count"] = uncited_count(ordered)
    return {"line_items": applied}


# --------------------------------------------------------------------------
# Promotion — human acceptance is what makes the spread deal-of-record data
# --------------------------------------------------------------------------


def current_spread(deal_id) -> list[dict]:
    return [
        row
        for row in store.list("spread_line_items")
        if row.get("deal_id") == deal_id and row.get("is_current") is not False
    ]


def citations_for_spread(deal_id) -> list[dict]:
    current_ids = {row["id"] for row in current_spread(deal_id)}
    return [
        row
        for row in store.list("citations")
        if row.get("deal_id") == deal_id and row.get("spread_line_item_id") in current_ids
    ]


def _supersede_existing(deal: dict, actor_user_id: str) -> int:
    superseded = 0
    for row in current_spread(deal["id"]):
        before = dict(row)
        row["is_current"] = False
        row["superseded_at"] = uw.now_iso()
        uw.save_row("spread_line_items", row, actor_user_id=actor_user_id, before=before)
        superseded += 1
    return superseded


def promote_spread(deal: dict, content: dict, actor: dict) -> dict:
    """Persist the accepted spread as structured line items with citations.

    Append-only in spirit: a re-accepted spread supersedes the prior rows
    rather than editing them, so the earlier deal-of-record stays readable.
    """
    superseded = _supersede_existing(deal, actor["username"])
    line_item_ids: list = []
    citation_ids: list = []
    for line in content.get("spread_line_items") or []:
        row = store.insert(
            "spread_line_items",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "line_item_key": line["line_item_key"],
                "category": line["category"],
                "label": line["label"],
                "value": line.get("value"),
                "unit": line.get("unit"),
                "period": line.get("period"),
                "is_supported": bool(line.get("supported")),
                "is_current": True,
                "superseded_at": None,
                "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
                "accepted_by_user_id": actor["username"],
                "accepted_at": uw.now_iso(),
            },
        )
        line_item_ids.append(row["id"])
        citation = line.get("citation") or {}
        if not line.get("supported"):
            continue
        citation_row = store.insert(
            "citations",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "cited_value": citation.get("cited_value") or line.get("display_value"),
                "source_type": citation.get("source_type") or "document_location",
                "source_reference": citation.get("source_reference"),
                "document_id": citation.get("document_id"),
                "document_location_id": citation.get("document_location_id"),
                "spread_line_item_id": row["id"],
                "ratio_id": None,
                "policy_rule_id": None,
                "excerpt": str(citation.get("excerpt") or "")[:400],
                "created_at": uw.now_iso(),
            },
        )
        citation_ids.append(citation_row["id"])

    audit = uw.audit_event(
        event_type="spread.persisted",
        action=(
            f"financial spread accepted by {actor['username']} and persisted as "
            f"{len(line_item_ids)} spread line item(s) with {len(citation_ids)} citation(s)"
        ),
        actor_user_id=actor["username"],
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="spread_line_items",
        entity_id=line_item_ids[0] if line_item_ids else None,
        new_values={
            "spread_line_item_ids": line_item_ids,
            "citation_ids": citation_ids,
            "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
            "unsupported_lines": content.get("unsupported_lines", []),
        },
        details={"superseded_line_items": superseded} if superseded else {},
    )
    uw._log(
        "spread.persisted",
        deal_reference=deal["deal_reference"],
        spread_line_item_count=len(line_item_ids),
        citation_count=len(citation_ids),
    )
    return {
        "spread_line_item_ids": line_item_ids,
        "citation_ids": citation_ids,
        "spread_line_item_count": len(line_item_ids),
        "citation_count": len(citation_ids),
        "uncited_figure_count": uncited_count(content.get("spread_line_items")),
        "unsupported_lines": content.get("unsupported_lines", []),
        "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
        "audit_log_id": audit["id"],
    }


# --------------------------------------------------------------------------
# Read model for the Draft Review workspace
# --------------------------------------------------------------------------


def spread_of_record(deal: dict) -> dict:
    rows = current_spread(deal["id"])
    citations = citations_for_spread(deal["id"])
    by_line = {row["spread_line_item_id"]: row for row in citations}
    return {
        "template_version": rows[0].get("template_version") if rows else SPREAD_TEMPLATE_VERSION,
        "accepted_by_user_id": rows[0].get("accepted_by_user_id") if rows else None,
        "accepted_at": rows[0].get("accepted_at") if rows else None,
        "line_items": [
            {
                "id": row["id"],
                "line_item_key": row["line_item_key"],
                "category": row["category"],
                "category_label": CATEGORY_LABELS.get(row["category"], row["category"]),
                "label": row["label"],
                "value": row.get("value"),
                "unit": row.get("unit"),
                "period": row.get("period"),
                "supported": bool(row.get("is_supported")),
                "display_value": f"{float(row['value']):,.0f}" if row.get("value") is not None else NOT_SUPPORTED,
                "citation": _citation_view(by_line.get(row["id"])),
            }
            for row in rows
        ],
        "citation_count": len(citations),
    }


def _citation_view(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "cited_value": row.get("cited_value"),
        "source_type": row.get("source_type"),
        "source_reference": row.get("source_reference"),
        "document_id": row.get("document_id"),
        "document_location_id": row.get("document_location_id"),
        "excerpt": row.get("excerpt"),
    }


def evidence_for_draft(deal: dict, draft: dict) -> list[dict]:
    """The evidence panel beside a draft: what each claim actually rests on."""
    content = draft.get("draft_content") or {}
    facts = spread_facts(deal)
    items: list[dict] = []
    if draft.get("draft_type") == "spread":
        for citation in content.get("citations") or []:
            items.append(
                {
                    "kind": "citation",
                    "line_item_key": citation.get("line_item_key"),
                    "title": f"{citation.get('label')} — {citation.get('cited_value')}",
                    "source_reference": citation.get("source_reference"),
                    "excerpt": citation.get("excerpt"),
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                    "source_type": citation.get("source_type"),
                }
            )
        for key in content.get("unsupported_lines") or []:
            items.append(
                {
                    "kind": "absent",
                    "line_item_key": key,
                    "title": f"{TEMPLATE_BY_KEY[key]['label']} — {NOT_SUPPORTED}",
                    "source_reference": NOT_SUPPORTED,
                    "excerpt": "No extracted document location for this deal states this template line.",
                }
            )
        return items

    # Triage (and any future draft type): the documents the classification and
    # the missing-document findings were drawn from.
    for document in facts["document_rows"]:
        locations = facts["locations_by_document"].get(document["id"], [])
        if locations:
            excerpt = str(locations[0].get("extracted_text") or "")[:400]
        else:
            excerpt = "No extractable text — this document is unreadable to the agents."
        items.append(
            {
                "kind": "document",
                "title": f"{document.get('original_filename')} — {document.get('document_type')}",
                "source_reference": f"document {document['id']} · {len(locations)} extracted location(s)",
                "excerpt": excerpt,
                "document_id": document["id"],
            }
        )
    for key in content.get("missing_documents") or []:
        items.append(
            {
                "kind": "absent",
                "title": f"{uw.DOCUMENT_TYPE_LABELS.get(key, key)} — not on file",
                "source_reference": "required-document checklist",
                "excerpt": "The checklist for this request type requires it; no document of this type is on file.",
            }
        )
    return items


# --------------------------------------------------------------------------
# Workflow handler — workflows.json `persist_spread` node contract
# --------------------------------------------------------------------------


def handler_persist_spread_line_items(context: dict) -> dict:
    """`deal-underwriting/persist_spread`.

    Idempotent by construction: human acceptance already persisted the spread
    of record through `promote_spread`, so the node confirms and names those
    rows rather than writing a second copy.
    """
    deal = uw._wf_deal(context)
    accepted = [
        row
        for row in uw.drafts_for(deal["id"], "spread")
        if row.get("review_status") in ("accepted", "edited")
    ]
    if not accepted:
        raise workflow_engine.WorkflowError("the financial spread has not been accepted by a named human")
    draft = accepted[-1]
    reviewer = draft.get("reviewed_by_user_id")
    rows = current_spread(deal["id"])
    if not rows:
        rows_result = promote_spread(deal, draft["draft_content"], {"username": reviewer})
        line_item_ids = rows_result["spread_line_item_ids"]
        citation_ids = rows_result["citation_ids"]
        audit_id = rows_result["audit_log_id"]
    else:
        line_item_ids = [row["id"] for row in rows]
        citation_ids = [row["id"] for row in citations_for_spread(deal["id"])]
        audit_id = uw.audit_event(
            event_type="spread.confirmed",
            action=f"{len(line_item_ids)} accepted spread line item(s) confirmed as the deal of record",
            actor_user_id=reviewer,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            entity_id=line_item_ids[0] if line_item_ids else None,
            new_values={"spread_line_item_ids": line_item_ids, "citation_ids": citation_ids},
        )["id"]
    return {
        "deal_id": deal["deal_reference"],
        "spread_line_item_ids": line_item_ids,
        "citation_ids": citation_ids,
        "reviewed_by_user_id": reviewer,
        "audit_log_id": audit_id,
    }


def register() -> None:
    workflow_engine.register_handler("persist_spread_line_items", handler_persist_spread_line_items)
    uw.register_draft_type("spread", promoter=promote_spread, editor=apply_spread_edits)


register()
