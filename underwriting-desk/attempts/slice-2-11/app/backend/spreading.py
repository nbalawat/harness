"""Financial spreading agent and the accepted spread of record (slice 2).

The agent reads ONLY the deal's extracted document locations and fills the
bank's standard spread template, attaching to every single figure a citation
naming the document and the document location it came from; template lines the
documents cannot support carry the exact phrase "not supported by the record".
Its output lands in a PENDING draft — a named analyst accepts, edits or rejects
it in the Draft Review workspace, and only that acceptance persists the spread
as ``spread_line_items`` with their ``citations``.

Composition contract (identical to underwriting.py, which owns the core):
  * every read/write goes through ``db.store``
  * every LLM call goes through ``agent_runtime.respond`` (via ``uw.run_agent``)
  * every state change appends an append-only audit row
  * NOTHING here computes DSCR, leverage, a current ratio or a grade — the
    ratio slice owns those, in deterministic code
  * a figure the model emits is admitted only if it appears verbatim in the
    document location it cites, so no number in the spread of record was ever
    computed, rounded or invented inside an LLM call
"""
from __future__ import annotations

import json
import re

import prompts
import underwriting as uw
import workflow_engine
from db import store

# --------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------

SPREAD_AGENT_NAME = "Financial Spreading Agent"
SPREAD_PROMPT_NAME = "financial_spread"
SPREAD_PROMPT_VERSION = 1
SPREAD_TEMPLATE_VERSION = "spread-template@2026.1"

NOT_SUPPORTED = "not supported by the record"

#: Deny-by-default role gate for running the spreading agent. The draft review
#: gate itself keeps using uw.DRAFT_REVIEW_ROLES.
SPREAD_ROLES = frozenset({"credit_analyst", "credit_officer"})

#: Stage a deal must have reached before its financials may be spread, the
#: stage the spreading work itself sits in, and where acceptance takes it.
SPREAD_ENTRY_STAGES = ("document_extraction", "financial_spreading")
SPREAD_STAGE = "financial_spreading"
SPREAD_NEXT_STAGE = "risk_grading"

#: The bank's standard spread template. The agent may fill these lines and no
#: others; `patterns` are the deterministic label matchers used to derive the
#: same lines from the record when the model's structured output does not
#: validate. Order is the order the analyst reads the spread in.
SPREAD_TEMPLATE = (
    {
        "key": "revenue",
        "label": "Total revenue",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("total revenue", "net sales", "gross receipts", "revenue"),
    },
    {
        "key": "cost_of_goods_sold",
        "label": "Cost of goods sold",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("cost of goods sold", "cost of sales", "cogs"),
    },
    {
        "key": "gross_profit",
        "label": "Gross profit",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("gross profit",),
    },
    {
        "key": "operating_expenses",
        "label": "Operating expenses",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("total operating expenses", "operating expenses", "opex"),
    },
    {
        "key": "ebitda",
        "label": "EBITDA",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("ebitda",),
    },
    {
        "key": "depreciation_amortisation",
        "label": "Depreciation & amortisation",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("depreciation and amortization", "depreciation & amortization", "depreciation"),
    },
    {
        "key": "interest_expense",
        "label": "Interest expense",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("interest expense",),
    },
    {
        "key": "net_income",
        "label": "Net income",
        "category": "income_statement",
        "unit": "USD",
        "patterns": ("net income", "ordinary business income"),
    },
    {
        "key": "current_assets",
        "label": "Current assets",
        "category": "balance_sheet",
        "unit": "USD",
        "patterns": ("total current assets", "current assets"),
    },
    {
        "key": "current_liabilities",
        "label": "Current liabilities",
        "category": "balance_sheet",
        "unit": "USD",
        "patterns": ("total current liabilities", "current liabilities"),
    },
    {
        "key": "inventory",
        "label": "Inventory",
        "category": "balance_sheet",
        "unit": "USD",
        "patterns": ("inventory",),
    },
    {
        "key": "total_debt",
        "label": "Total funded debt",
        "category": "balance_sheet",
        "unit": "USD",
        "patterns": ("total funded debt", "funded debt", "total debt"),
    },
    {
        "key": "tangible_net_worth",
        "label": "Tangible net worth",
        "category": "balance_sheet",
        "unit": "USD",
        "patterns": ("tangible net worth",),
    },
    {
        "key": "annual_debt_service",
        "label": "Annual debt service (P&I)",
        "category": "debt_service",
        "unit": "USD",
        "patterns": ("annual principal and interest", "annual debt service", "principal and interest"),
    },
)

TEMPLATE_BY_KEY = {spec["key"]: spec for spec in SPREAD_TEMPLATE}

CATEGORY_LABELS = {
    "income_statement": "Income statement",
    "balance_sheet": "Balance sheet",
    "debt_service": "Debt service",
}

#: Which document a figure is preferably taken from: audited statements before
#: interim numbers, interim before a tax return.
_DOCUMENT_PRIORITY = (
    "financial_statements",
    "interim_financials",
    "business_tax_return",
    "personal_tax_return",
    "debt_schedule",
    "ar_aging",
    "ap_aging",
    "bank_statements",
)

#: Largest figure admitted onto a template line — a defensive bound so a
#: malformed document cannot land an absurd number on the deal of record.
MAX_FIGURE = 1_000_000_000_000.0

_PERIOD_RE = re.compile(r"\b(?:FY|fiscal year|tax year|year ended)\s*(20\d{2})\b", re.IGNORECASE)


# --------------------------------------------------------------------------
# Deterministic extraction from the extracted document locations
# --------------------------------------------------------------------------


def _to_amount(raw: str) -> float | None:
    text = str(raw or "").strip()
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    if not cleaned or cleaned in {"-", ".", "-."}:
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    if negative:
        value = -abs(value)
    if abs(value) > MAX_FIGURE:
        return None
    return round(value, 2)


def _match_figure(text: str, pattern: str) -> float | None:
    """The number stated immediately after a template label in one location."""
    match = re.search(
        re.escape(pattern) + r"[^0-9(]{0,24}(\(?-?\$?\s?[0-9][0-9,]*(?:\.[0-9]+)?\)?)",
        str(text or ""),
        re.IGNORECASE,
    )
    if match is None:
        return None
    return _to_amount(match.group(1))


def deal_locations(deal: dict) -> tuple[list[dict], list[dict]]:
    """The deal's document rows and its extracted locations, ordered so the
    most authoritative document is read first."""
    documents = uw.documents_for(deal["id"])
    by_id = {d["id"]: d for d in documents}
    locations = uw.locations_for(list(by_id))

    def rank(location):
        document = by_id.get(location.get("document_id")) or {}
        document_type = document.get("document_type")
        priority = _DOCUMENT_PRIORITY.index(document_type) if document_type in _DOCUMENT_PRIORITY else len(_DOCUMENT_PRIORITY)
        return (priority, location.get("document_id") or 0, location.get("id") or 0)

    return documents, sorted(locations, key=rank)


def _document_of(documents: list[dict], document_id) -> dict:
    for row in documents:
        if row["id"] == document_id:
            return row
    return {}


def _period_for(location: dict, document: dict, locations: list[dict]) -> str | None:
    match = _PERIOD_RE.search(str(location.get("extracted_text") or ""))
    if match is None:
        for other in locations:
            if other.get("document_id") != document.get("id"):
                continue
            match = _PERIOD_RE.search(str(other.get("extracted_text") or ""))
            if match:
                break
    return f"FY{match.group(1)}" if match else None


def _source_reference(document: dict, location: dict) -> str:
    return (
        f"{document.get('original_filename') or 'document ' + str(document.get('id'))}"
        f" · p.{location.get('page_number')} · {location.get('section') or 'body'}"
    )


def _stated_literal(text: str, value: float) -> str | None:
    """The figure exactly as the document renders it ("12,400,000")."""
    for match in _STATED_NUMBER_RE.finditer(str(text or "")):
        if _to_amount(match.group(0)) == value:
            return match.group(0).strip()
    return None


def _supported_item(spec: dict, value: float, location: dict, document: dict, locations: list[dict], matched_on: str | None) -> dict:
    return {
        "line_item_key": spec["key"],
        "label": spec["label"],
        "category": spec["category"],
        "category_label": CATEGORY_LABELS.get(spec["category"], spec["category"]),
        "unit": spec["unit"],
        "period": _period_for(location, document, locations),
        "value": value,
        "supported": True,
        "citation": {
            "source_type": "document_location",
            "document_id": document.get("id"),
            "document_location_id": location.get("id"),
            "document_filename": document.get("original_filename"),
            "document_type": document.get("document_type"),
            "page_number": location.get("page_number"),
            "section": location.get("section"),
            "excerpt": str(location.get("extracted_text") or "")[:240],
            # The document's own rendering of the figure, not a re-formatting of
            # the number the model handed back.
            "cited_value": _stated_literal(location.get("extracted_text"), value) or f"{value:,.2f}",
            "source_reference": _source_reference(document, location),
            "matched_on": matched_on,
        },
    }


def _unsupported_item(spec: dict) -> dict:
    return {
        "line_item_key": spec["key"],
        "label": spec["label"],
        "category": spec["category"],
        "category_label": CATEGORY_LABELS.get(spec["category"], spec["category"]),
        "unit": spec["unit"],
        "period": None,
        "value": None,
        "supported": False,
        "citation": {
            "source_type": "unsupported",
            "document_id": None,
            "document_location_id": None,
            "document_filename": None,
            "document_type": None,
            "page_number": None,
            "section": None,
            "excerpt": NOT_SUPPORTED,
            "cited_value": NOT_SUPPORTED,
            "source_reference": NOT_SUPPORTED,
            "matched_on": None,
        },
    }


def derive_line_items(deal: dict) -> list[dict]:
    """Fill the template from the record itself — the deterministic reading the
    app falls back to when the model's structured output does not validate."""
    documents, locations = deal_locations(deal)
    items = []
    for spec in SPREAD_TEMPLATE:
        hit = None
        for location in locations:
            for pattern in spec["patterns"]:
                value = _match_figure(location.get("extracted_text"), pattern)
                if value is None:
                    continue
                hit = (value, location, pattern)
                break
            if hit:
                break
        if hit is None:
            items.append(_unsupported_item(spec))
            continue
        value, location, pattern = hit
        items.append(_supported_item(spec, value, location, _document_of(documents, location.get("document_id")), locations, pattern))
    return items


# --------------------------------------------------------------------------
# The agent: prompt, validation, draft
# --------------------------------------------------------------------------

SPREAD_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name
Facility type: $facility_type

Standard spread template — fill these line item keys and NO others:
$template_lines

The ONLY evidence you may use is these extracted document locations:
$location_catalog

Return ONLY a JSON object shaped exactly like this and nothing else:
{"line_items": [
   {"line_item_key": "<template key>",
    "value": <the number exactly as stated in the cited location, digits only>,
    "document_id": <the document id of the citation>,
    "document_location_id": <the document location id the figure was read from>}
 ],
 "unsupported": ["<template key the documents cannot support>"],
 "notes": "<one sentence, drawn only from the record>"}

Rules: every figure you emit MUST carry a document_id and a document_location_id
from the catalogue above and must appear verbatim in that location's text — an
uncited or altered figure is invalid output. Never invent a line item key. Do
not add, subtract or otherwise compute any number. Do not compute DSCR,
leverage or the current ratio; the system computes those. For any template line
the documents cannot support, list its key under "unsupported" — that line will
be recorded as "$not_supported"."""

prompts.register(SPREAD_PROMPT_NAME, SPREAD_PROMPT_TEXT, version=SPREAD_PROMPT_VERSION)


def build_spread_prompt(deal: dict, documents: list[dict], locations: list[dict]) -> str:
    template_lines = "\n".join(
        f"- {spec['key']} ({CATEGORY_LABELS[spec['category']]}, {spec['unit']}): {spec['label']}"
        for spec in SPREAD_TEMPLATE
    )
    catalogue = (
        "\n".join(
            "- location {id} (document {doc}, {filename}, page {page}, section {section}): {text}".format(
                id=location["id"],
                doc=location.get("document_id"),
                filename=(_document_of(documents, location.get("document_id")).get("original_filename") or "document"),
                page=location.get("page_number"),
                section=location.get("section"),
                text=str(location.get("extracted_text") or "")[:240],
            )
            for location in locations[:120]
        )
        or "- none extracted for this deal"
    )
    return prompts.render(
        SPREAD_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        facility_type=deal["facility_type"],
        template_lines=template_lines,
        location_catalog=catalogue,
        not_supported=NOT_SUPPORTED,
    )


def spread_run_inputs(deal: dict, documents: list[dict], locations: list[dict]) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": [d["id"] for d in documents],
        "document_location_ids": [loc["id"] for loc in locations],
        "template_version": SPREAD_TEMPLATE_VERSION,
        "template_keys": [spec["key"] for spec in SPREAD_TEMPLATE],
    }


#: A number as a document states it, with its own thousands separators and an
#: accounting-negative in parentheses.
_STATED_NUMBER_RE = re.compile(r"\(?-?\$?\s?[0-9][0-9,]*(?:\.[0-9]+)?\)?")


def stated_numbers(text: str) -> set[float]:
    """Every number the document location states, as whole tokens.

    Whole tokens, not a substring scan: `1180` must not be admitted because the
    location happens to state `118,000`.
    """
    found = set()
    for match in _STATED_NUMBER_RE.finditer(str(text or "")):
        amount = _to_amount(match.group(0))
        if amount is not None:
            found.add(amount)
    return found


def _states_value(location: dict, spec: dict, value: float) -> bool:
    """Does the cited location state this figure, for THIS template line?

    Three conditions, and all of them must hold. This is the guard that keeps
    LLM arithmetic out of the deal of record:

      1. the value appears in the location as a whole number token, sign and
         all — not as a digit substring of some other figure;
      2. the location actually mentions the template line's own label, so a
         real number cannot be filed under a line it does not belong to
         (citing "Total revenue 4,500,000" for `total_debt`);
      3. re-reading the location deterministically for that label yields the
         same number — a label the app cannot parse a figure from is not
         evidence for one, so the figure is refused rather than admitted on
         conditions 1 and 2 alone (a location reading "current assets increased
         … total funded debt of 8,000,000 was refinanced" must not be able to
         put 8,000,000 on the current-assets line).
    """
    text = str(location.get("extracted_text") or "")
    if value not in stated_numbers(text):
        return False
    for pattern in spec["patterns"]:
        if pattern not in text.lower():
            continue
        if _match_figure(text, pattern) == value:
            return True
    return False


def parse_spread_reply(reply: str, *, documents: list[dict], locations: list[dict]) -> list[dict] | None:
    """Accept the agent's structured spread only if EVERY figure validates:
    a known template key, a citation into this deal's own extracted locations,
    and a value the cited location states verbatim. Anything else is refused
    wholesale — a half-trusted spread is worse than a derived one."""
    by_location = {loc["id"]: loc for loc in locations}
    for blob in uw.json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict) or not isinstance(parsed.get("line_items"), list):
            continue
        accepted: dict[str, dict] = {}
        valid = True
        for raw in parsed["line_items"]:
            if not isinstance(raw, dict):
                valid = False
                break
            spec = TEMPLATE_BY_KEY.get(raw.get("line_item_key"))
            location = by_location.get(raw.get("document_location_id"))
            value = _to_amount(raw.get("value")) if not isinstance(raw.get("value"), bool) else None
            if spec is None or location is None or value is None:
                valid = False
                break
            if raw.get("document_id") is not None and raw.get("document_id") != location.get("document_id"):
                valid = False
                break
            if not _states_value(location, spec, value):
                valid = False
                break
            if spec["key"] in accepted:
                valid = False
                break
            document = _document_of(documents, location.get("document_id"))
            accepted[spec["key"]] = _supported_item(spec, value, location, document, locations, None)
        if not valid:
            continue
        return [accepted.get(spec["key"]) or _unsupported_item(spec) for spec in SPREAD_TEMPLATE]
    return None


def spread_content(deal: dict, reply: str) -> dict:
    documents, locations = deal_locations(deal)
    items = parse_spread_reply(reply, documents=documents, locations=locations)
    source = "agent"
    if items is None:
        items = derive_line_items(deal)
        source = "deterministic-fallback"
    content = {
        "template_version": SPREAD_TEMPLATE_VERSION,
        "source": source,
        "line_items": items,
        "documents_considered": [
            {"document_id": d["id"], "document_type": d.get("document_type"), "original_filename": d.get("original_filename")}
            for d in documents
        ],
        "location_count": len(locations),
        "not_supported_phrase": NOT_SUPPORTED,
    }
    recount(content)
    content["rationale"] = (
        f"{content['supported_count']} of {len(items)} template lines are supported by "
        f"{len(locations)} extracted document location(s); the remainder are recorded as '{NOT_SUPPORTED}'."
    )
    return content


def recount(content: dict) -> dict:
    """Recompute the citation-integrity counters the reviewer reads.

    Kept in one place so a human edit can never leave the draft asserting an
    integrity it no longer has: a figure the analyst typed is cited to the
    analyst, not to a document location, and is counted as such.
    """
    items = content.get("line_items") or []
    supported = [item for item in items if item.get("supported")]
    document_cited = [item for item in supported if (item.get("citation") or {}).get("document_location_id")]
    human_edited = [item for item in supported if (item.get("citation") or {}).get("source_type") == "human_edit"]
    content["supported_count"] = len(supported)
    content["unsupported_count"] = len(items) - len(supported)
    content["document_cited_count"] = len(document_cited)
    content["human_edited_count"] = len(human_edited)
    # Every figure carries a citation by construction; the count is reported so
    # the reviewer sees the invariant rather than being asked to trust it.
    content["uncited_figure_count"] = len(supported) - len(document_cited) - len(human_edited)
    return content


def _park(deal: dict, content: dict, agent_run_id, actor_user_id: str) -> dict:
    return uw.park_agent_draft(
        deal=deal,
        draft_type="spread",
        content=content,
        agent_run_id=agent_run_id,
        actor_user_id=actor_user_id,
        action="financial spread drafted by the spreading agent (pending human acceptance)",
    )


def _workflow_node_prompt(run_id: str | None) -> str | None:
    """The `spread_financials` node's own prompt text, so the run record costs
    and quotes the call that actually produced the reply."""
    for workflow in workflow_engine.definitions():
        if workflow.get("name") != "deal-underwriting":
            continue
        for node in workflow.get("nodes", []):
            if node.get("id") == "spread_financials":
                return node.get("prompt")
    return None


def adopt_workflow_spread(deal: dict, actor_user_id: str) -> dict | None:
    """Adopt the approved process's OWN spread_financials output as the draft.

    The `deal-underwriting` run already executed that agent node when the triage
    gate was accepted; re-prompting here would double the cost and — worse —
    mean the spread a human reviews is not the one the process produced.
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
    documents, locations = deal_locations(deal)
    run = uw.record_agent_run(
        deal=deal,
        agent_name=SPREAD_AGENT_NAME,
        agent_type="financial_spreading",
        run_stage=SPREAD_STAGE,
        prompt_name=SPREAD_PROMPT_NAME,
        prompt=_workflow_node_prompt(run_id) or build_spread_prompt(deal, documents, locations),
        reply=reply,
        # The output came from the process definition's own node prompt, so the
        # run record names that prompt rather than this module's template.
        prompt_version_override="deal-underwriting/spread_financials@workflows.json",
        inputs=spread_run_inputs(deal, documents, locations)
        | {
            "workflow_run_id": run_id,
            "workflow_node": "spread_financials",
            "latency_note": "not measured — this node ran inside the triage-acceptance workflow tick",
        },
        # The engine exposes no per-node timing and this node ran inside an
        # earlier request, so the latency is recorded as unknown rather than as
        # a zero that would read like a measurement.
        latency_ms=None,
        actor_user_id=actor_user_id,
    )
    return _park(deal, spread_content(deal, reply), run["id"], actor_user_id)


def build_spread_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the spreading agent directly and park the result as a PENDING draft
    (used when there is no unconsumed workflow output to adopt — a re-spread
    after a rejection, say). Nothing here persists or advances anything."""
    documents, locations = deal_locations(deal)
    outcome = uw.run_agent(
        agent_name=SPREAD_AGENT_NAME,
        prompt=build_spread_prompt(deal, documents, locations),
        deal=deal,
        agent_type="financial_spreading",
        run_stage=SPREAD_STAGE,
        prompt_name=SPREAD_PROMPT_NAME,
        inputs=spread_run_inputs(deal, documents, locations),
        actor_user_id=actor_user_id,
    )
    return _park(deal, spread_content(deal, outcome["reply"]), outcome["run"]["id"], actor_user_id)


def run_spreading_agent(deal: dict, actor: dict) -> tuple[dict, bool]:
    """The Draft Review workspace's 'run the spreading agent' action.

    Returns the pending draft and whether this call created it. The stage move
    into financial_spreading is the analyst's own act (named, audited) — it is
    never triggered by agent output.
    """
    if deal.get("is_closed"):
        raise uw.DomainError(409, f"deal {deal['deal_reference']} is closed")
    if deal.get("current_stage") not in SPREAD_ENTRY_STAGES:
        raise uw.DomainError(
            409,
            f"deal {deal['deal_reference']} is at '{deal.get('current_stage')}' — the intake triage draft must be "
            f"accepted first so the deal reaches '{SPREAD_ENTRY_STAGES[0]}' before its financials can be spread",
        )
    if uw.pending_draft(deal["id"], "triage") is not None:
        raise uw.DomainError(409, "the intake triage draft is still pending a human decision on this deal")

    existing = uw.pending_draft(deal["id"], "spread")
    if existing is not None:
        return existing, False

    if deal.get("current_stage") == SPREAD_ENTRY_STAGES[0]:
        uw.record_transition(deal, SPREAD_STAGE, actor["username"], reason="analyst opened financial spreading")

    draft = adopt_workflow_spread(deal, actor["username"])
    if draft is None:
        draft = build_spread_draft(deal, actor["username"])
    return draft, True


# --------------------------------------------------------------------------
# Human acceptance: the spread becomes deal-of-record data
# --------------------------------------------------------------------------


def accepted_spread(deal_id) -> tuple[list[dict], list[dict]]:
    items = [row for row in store.list("spread_line_items") if row.get("deal_id") == deal_id]
    item_ids = {row["id"] for row in items}
    citations = [row for row in store.list("citations") if row.get("spread_line_item_id") in item_ids]
    return items, citations


def persist_accepted_spread(deal: dict, content: dict, actor: dict) -> dict:
    """Only a named human's acceptance reaches this function (promote_draft).

    Idempotent: a replayed acceptance or a workflow tick that reaches
    persist_spread later returns the spread already on file rather than
    doubling it.
    """
    existing_items, existing_citations = accepted_spread(deal["id"])
    if existing_items:
        return {
            "spread_line_item_ids": [row["id"] for row in existing_items],
            "citation_ids": [row["id"] for row in existing_citations],
            "spread_line_items_persisted": len(existing_items),
            "citations_persisted": len(existing_citations),
            "already_on_file": True,
        }

    item_ids: list[int] = []
    citation_ids: list[int] = []
    for item in content.get("line_items") or []:
        spec = TEMPLATE_BY_KEY.get(item.get("line_item_key"))
        if spec is None:  # never persist a line outside the approved template
            continue
        citation = item.get("citation") or {}
        row = store.insert(
            "spread_line_items",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "line_item_key": spec["key"],
                "category": spec["category"],
                "label": spec["label"],
                "value": item.get("value"),
                "unit": spec["unit"],
                "period": item.get("period"),
                "support_status": "supported" if item.get("supported") else "not_supported",
                "template_version": SPREAD_TEMPLATE_VERSION,
                "source": content.get("source"),
                "accepted_by_user_id": actor["username"],
                "accepted_at": uw.now_iso(),
            },
        )
        item_ids.append(row["id"])
        citation_row = store.insert(
            "citations",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "cited_value": citation.get("cited_value"),
                "source_type": citation.get("source_type") or "unsupported",
                "source_reference": citation.get("source_reference") or NOT_SUPPORTED,
                "document_id": citation.get("document_id"),
                "document_location_id": citation.get("document_location_id"),
                "spread_line_item_id": row["id"],
                "ratio_id": None,
                "policy_rule_id": None,
                "excerpt": citation.get("excerpt"),
                "created_at": uw.now_iso(),
            },
        )
        citation_ids.append(citation_row["id"])

    audit = uw.audit_event(
        event_type="spread.accepted",
        action=f"financial spread accepted by {actor['username']} and persisted as deal-of-record data",
        actor_user_id=actor["username"],
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="spread_line_items",
        entity_id=item_ids[0] if item_ids else None,
        new_values={
            "spread_line_item_count": len(item_ids),
            "citation_count": len(citation_ids),
            "template_version": SPREAD_TEMPLATE_VERSION,
            "source": content.get("source"),
        },
    )
    return {
        "spread_line_item_ids": item_ids,
        "citation_ids": citation_ids,
        "spread_line_items_persisted": len(item_ids),
        "citations_persisted": len(citation_ids),
        "template_version": SPREAD_TEMPLATE_VERSION,
        "audit_log_id": audit["id"],
        "already_on_file": False,
    }


def apply_spread_edits(content: dict, edits: dict) -> dict:
    """An analyst's correction to a drafted figure.

    Accepts ``{"line_items": {"<template key>": <number|null>}}``. A null clears
    the line to "not supported by the record". The edited figure is a named
    human's number, so its citation says exactly that instead of pointing at a
    document location that does not state it.
    """
    raw = edits.get("line_items")
    if raw in (None, {}, []):
        return {}
    if isinstance(raw, list):
        try:
            raw = {item["line_item_key"]: item.get("value") for item in raw}
        except (TypeError, KeyError):
            raise uw.DomainError(400, "line_items edits must name a line_item_key and a value")
    if not isinstance(raw, dict):
        raise uw.DomainError(400, "line_items edits must be an object of {line_item_key: value}")

    by_key = {item["line_item_key"]: item for item in content.get("line_items") or []}
    applied: dict = {}
    for key, value in raw.items():
        spec = TEMPLATE_BY_KEY.get(key)
        if spec is None:
            raise uw.DomainError(400, f"'{key}' is not a line on the standard spread template")
        item = by_key.get(key)
        if item is None:
            raise uw.DomainError(400, f"this draft carries no '{key}' line")
        previous = item.get("value")
        if value is None or (isinstance(value, str) and not value.strip()):
            cleared = _unsupported_item(spec)
            item.update(cleared)
            applied[f"line_items.{key}"] = {"from": previous, "to": None}
            continue
        amount = _to_amount(value) if not isinstance(value, bool) else None
        if amount is None:
            raise uw.DomainError(400, f"'{key}' must be edited to a number or null")
        item["value"] = amount
        item["supported"] = True
        item["citation"] = {
            "source_type": "human_edit",
            "document_id": None,
            "document_location_id": None,
            "document_filename": None,
            "document_type": None,
            "page_number": None,
            "section": None,
            "excerpt": "figure corrected by the reviewing analyst at the draft review gate",
            "cited_value": f"{amount:,.2f}",
            "source_reference": "human edit at draft review",
            "matched_on": None,
        }
        applied[f"line_items.{key}"] = {"from": previous, "to": amount}

    if applied:
        recount(content)
    return applied


# --------------------------------------------------------------------------
# Workflow handler (deal-underwriting / persist_spread)
# --------------------------------------------------------------------------


def handler_persist_spread_line_items(context: dict) -> dict:
    """`persist_spread` node: record the accepted spread as deal-of-record data.

    Contract (workflows.json): deal_id, spread_line_item_ids, citation_ids,
    reviewed_by_user_id, audit_log_id. Idempotent — the review endpoint already
    persisted on acceptance, so a later tick confirms rather than duplicates.
    """
    deal = uw.workflow_deal(context)
    draft = None
    for row in reversed(uw.drafts_for(deal["id"], "spread")):
        if row.get("review_status") in ("accepted", "edited"):
            draft = row
            break
    if draft is None:
        raise workflow_engine.WorkflowError("the financial spread has not been accepted by a named human")
    reviewer = draft.get("reviewed_by_user_id")
    actor = uw.get_user(reviewer) or {"username": reviewer}
    result = persist_accepted_spread(deal, draft.get("draft_content") or {}, actor)
    audit_log_id = result.get("audit_log_id")
    if audit_log_id is None:
        audit_log_id = uw.audit_event(
            event_type="spread.persist_confirmed",
            action="workflow confirmed the accepted spread already on file",
            actor_user_id=reviewer,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            new_values={"spread_line_item_count": result.get("spread_line_items_persisted")},
        )["id"]
    return {
        "deal_id": deal["deal_reference"],
        "spread_line_item_ids": result["spread_line_item_ids"],
        "citation_ids": result["citation_ids"],
        "reviewed_by_user_id": reviewer,
        "audit_log_id": audit_log_id,
    }


# --------------------------------------------------------------------------
# Registration — the core module never has to know this file exists
# --------------------------------------------------------------------------

uw.DRAFT_STAGE_ADVANCE["spread"] = (SPREAD_STAGE, SPREAD_NEXT_STAGE)
uw.register_promoter("spread", persist_accepted_spread)
uw.register_editor("spread", apply_spread_edits)
uw.register_handler("persist_spread_line_items", handler_persist_spread_line_items)
