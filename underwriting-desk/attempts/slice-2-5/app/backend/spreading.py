"""Financial spreading agent + the spread half of the draft review workspace.

Slice 2 owns this module.

Composition contract honoured here (same as ``underwriting``):
  * every read/write goes through ``db.store``
  * the only LLM call is ``underwriting.run_agent`` -> ``agent_runtime.respond()``
  * every figure that reaches the deal of record carries a citation naming the
    document AND the document location it came from
  * a figure the agent proposes is accepted only if the number it claims is
    actually present in the location it cites — the model never invents money
  * nothing is persisted until a named human accepts the draft at the gate
"""
from __future__ import annotations

import json
import re

import agent_runtime
import prompts
import workflow_engine
import underwriting as uw
from db import store

# --------------------------------------------------------------------------
# The bank's standard spread template (REQ-005 / REQ-031)
# --------------------------------------------------------------------------

SPREAD_TEMPLATE_VERSION = "spread-template@2026.1"

#: line_item_key -> the template line. `synonyms` are the statement captions the
#: deterministic extractor recognises; the agent is given the same key list and
#: may not emit a key outside it.
SPREAD_TEMPLATE = (
    {
        "key": "revenue",
        "category": "income_statement",
        "label": "Revenue",
        "synonyms": ("revenue", "total revenue", "net sales", "gross receipts", "sales"),
    },
    {
        "key": "cost_of_goods_sold",
        "category": "income_statement",
        "label": "Cost of goods sold",
        "synonyms": ("cost of goods sold", "cogs", "cost of sales"),
    },
    {
        "key": "gross_profit",
        "category": "income_statement",
        "label": "Gross profit",
        "synonyms": ("gross profit",),
    },
    {
        "key": "operating_expenses",
        "category": "income_statement",
        "label": "Operating expenses",
        "synonyms": ("operating expenses", "total operating expenses", "opex"),
    },
    {
        "key": "ebitda",
        "category": "income_statement",
        "label": "EBITDA",
        "synonyms": ("ebitda",),
    },
    {
        "key": "depreciation_amortisation",
        "category": "income_statement",
        "label": "Depreciation & amortisation",
        "synonyms": ("depreciation and amortization", "depreciation & amortization", "depreciation"),
    },
    {
        "key": "interest_expense",
        "category": "income_statement",
        "label": "Interest expense",
        "synonyms": ("interest expense", "interest paid"),
    },
    {
        "key": "net_income",
        "category": "income_statement",
        "label": "Net income",
        "synonyms": ("net income", "ordinary business income", "net profit"),
    },
    {
        "key": "current_assets",
        "category": "balance_sheet",
        "label": "Current assets",
        "synonyms": ("current assets", "total current assets"),
    },
    {
        "key": "current_liabilities",
        "category": "balance_sheet",
        "label": "Current liabilities",
        "synonyms": ("current liabilities", "total current liabilities"),
    },
    {
        "key": "total_debt",
        "category": "balance_sheet",
        "label": "Total debt",
        "synonyms": ("total debt", "funded debt", "total interest-bearing debt"),
    },
    {
        "key": "tangible_net_worth",
        "category": "balance_sheet",
        "label": "Tangible net worth",
        "synonyms": ("tangible net worth", "net worth", "total equity"),
    },
    {
        "key": "annual_debt_service",
        "category": "debt_service",
        "label": "Annual debt service (P&I)",
        "synonyms": (
            "annual principal and interest",
            "annual debt service",
            "principal and interest",
            "debt service",
        ),
    },
)

TEMPLATE_BY_KEY = {line["key"]: line for line in SPREAD_TEMPLATE}
TEMPLATE_KEYS = tuple(line["key"] for line in SPREAD_TEMPLATE)

CATEGORY_LABELS = {
    "income_statement": "Income statement",
    "balance_sheet": "Balance sheet",
    "debt_service": "Debt service",
}

NOT_SUPPORTED = "not supported by the record"

#: Which document a figure is preferentially taken from. Audited financials
#: outrank a tax return, which outranks everything else — deterministic, so two
#: runs over the same record produce the same spread.
DOCUMENT_PRIORITY = (
    "financial_statements",
    "interim_financials",
    "business_tax_return",
    "personal_tax_return",
    "debt_schedule",
    "ar_aging",
    "ap_aging",
    "personal_financial_statement",
)

#: The only documents a spread figure may be read from — a business plan, an
#: equipment quote or an insurance certificate is not a financial statement, and
#: neither the agent nor the deterministic reader may cite one for a figure that
#: ends up driving the risk grade.
SPREADABLE_DOCUMENT_TYPES = frozenset(DOCUMENT_PRIORITY)

SPREAD_PROMPT_NAME = "financial_spread"
SPREAD_PROMPT_VERSION = 1
SPREAD_AGENT_NAME = "Financial Spreading Agent"

#: Roles that may run the spreading agent (deny by default, FSI rule 4).
SPREAD_ROLES = frozenset({"credit_analyst", "credit_officer"})

#: Roles that may READ a draft body. A draft now quotes the borrower's financial
#: statements, so these reads name an actor exactly like the writes do (the
#: app's documented HTTP contract) instead of answering to nobody at all — and
#: row scoping is then applied to whoever that is.
DRAFT_READ_ROLES = frozenset(
    {"relationship_manager", "credit_analyst", "credit_officer", "credit_committee_chair", "admin"}
)

#: Stages a spread may be drafted in. Before document_extraction the intake
#: triage draft has not been accepted, so spreading must not start.
SPREAD_START_STAGE = "document_extraction"
SPREAD_STAGE = "financial_spreading"

#: A human acceptance of the spread advances the deal to risk grading.
uw.DRAFT_STAGE_ADVANCE["spread"] = (SPREAD_STAGE, "risk_grading")

MAX_EXCERPT = 240


# --------------------------------------------------------------------------
# Deterministic figure extraction (never an LLM)
# --------------------------------------------------------------------------

_NUMBER = r"\(?-?\$?\s?[0-9][0-9,]*(?:\.[0-9]+)?\)?"
_PERIOD_RE = re.compile(r"\bFY\s?(\d{4})\b|\btax year\s+(\d{4})\b|\bfiscal year\s+(\d{4})\b", re.I)


def _matcher(synonym: str) -> re.Pattern:
    """The caption must OPEN the statement line, then the figure follows it.

    Anchoring at the start of the location is what makes the caption a caption.
    An unanchored `\bsales\b` would read "Cost of Sales 7,300,000" as revenue,
    "Accumulated Depreciation" as the depreciation expense and "Deferred
    revenue" as revenue — every one of them a wrong figure on a real line. A
    caption this app does not recognise as the head of the line is reported as
    `not supported by the record`, which is the safe direction for money.
    """
    return re.compile(
        r"^\s*" + re.escape(synonym).replace(r"\ ", r"\s+") + r"\b[\s:=\-–—of]{0,12}(" + _NUMBER + r")",
        re.I,
    )


_MATCHERS = {
    line["key"]: [(_matcher(s), s) for s in sorted(line["synonyms"], key=len, reverse=True)]
    for line in SPREAD_TEMPLATE
}


def parse_amount(raw) -> float | None:
    """'$1,420,000' / '(310,000)' -> float. Deterministic, no locale guessing."""
    text = str(raw or "").strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^0-9.\-]", "", text)
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return round(-value if negative and value > 0 else value, 2)


def _document_rank(document: dict) -> tuple:
    kind = document.get("document_type") or ""
    rank = DOCUMENT_PRIORITY.index(kind) if kind in DOCUMENT_PRIORITY else len(DOCUMENT_PRIORITY)
    return (rank, document.get("id") or 0)


def _period_for(texts) -> str:
    for text in texts:
        match = _PERIOD_RE.search(str(text or ""))
        if match:
            year = next(group for group in match.groups() if group)
            return f"FY{year}"
    return "period not stated in the record"


def _source_reference(document: dict, location: dict) -> str:
    return (
        f"{document.get('original_filename')} · p.{location.get('page_number')} · "
        f"{location.get('section') or 'body'}"
    )


def _citation_from(document: dict, location: dict, cited_value: str) -> dict:
    return {
        "document_id": document["id"],
        "document_location_id": location["id"],
        "source_type": "document_location",
        "source_reference": _source_reference(document, location),
        "document_filename": document.get("original_filename"),
        "document_type": document.get("document_type"),
        "page_number": location.get("page_number"),
        "section": location.get("section"),
        "excerpt": str(location.get("extracted_text") or "")[:MAX_EXCERPT],
        "cited_value": cited_value,
    }


def spread_facts(deal: dict) -> dict:
    """Everything the spread is allowed to read: this deal's extracted document
    locations and nothing else (REQ-031)."""
    documents = sorted(
        [d for d in uw.documents_for(deal["id"]) if d.get("document_type") in SPREADABLE_DOCUMENT_TYPES],
        key=_document_rank,
    )
    locations = uw.locations_for([d["id"] for d in documents])
    by_document: dict = {}
    for location in locations:
        by_document.setdefault(location["document_id"], []).append(location)
    for rows in by_document.values():
        rows.sort(key=lambda r: (r.get("page_number") or 0, r["id"]))
    return {
        "documents": documents,
        "locations": locations,
        "by_document": by_document,
        "documents_by_id": {d["id"]: d for d in documents},
        "locations_by_id": {loc["id"]: loc for loc in locations},
    }


def read_record(facts: dict) -> dict:
    """Every captioned figure the record states, per template line.

    Returns key -> list of readings (each with its value, period and exact
    citation), in document-priority order. Nothing is chosen here — choosing is
    `extract_figures`' job, and it refuses to choose when the record disagrees
    with itself.
    """
    readings: dict = {}
    for document in facts["documents"]:
        rows = facts["by_document"].get(document["id"], [])
        period = _period_for([r.get("extracted_text") for r in rows] + [document.get("original_filename")])
        for location in rows:
            text = str(location.get("extracted_text") or "")
            for key, matchers in _MATCHERS.items():
                for pattern, synonym in matchers:
                    match = pattern.search(text)
                    if not match:
                        continue
                    value = parse_amount(match.group(1))
                    if value is None:
                        continue
                    readings.setdefault(key, []).append(
                        {
                            "value": value,
                            "period": period,
                            "caption": synonym,
                            "citation": _citation_from(document, location, match.group(1).strip()),
                        }
                    )
                    break  # one reading per location per line
    return readings


def extract_figures(facts: dict) -> dict:
    """The app's own reading of the record: every figure it returns is a literal
    number standing under its own caption in a specific document location, so
    its citation is exact by construction.

    When the documents state MORE THAN ONE figure for the same template line
    (a prior-year column, a summary page that disagrees, or a line planted in an
    uploaded document), the app does not pick a winner: the line comes back
    `conflicted`, carrying every reading, and reaches the reviewer as
    `not supported by the record` for a human to resolve. Silently taking the
    first one is how a wrong number gets into a risk grade.
    """
    found: dict = {}
    for key, readings in read_record(facts).items():
        values = sorted({r["value"] for r in readings})
        if len(values) > 1:
            found[key] = {"conflict": readings, "values": values}
            continue
        found[key] = readings[0]
    return found


# --------------------------------------------------------------------------
# The spreading agent (roster agent 2) — proposes figures, never persists them
# --------------------------------------------------------------------------

SPREAD_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name
Requested facility: $facility_type

Standard spread template lines (use the key exactly, one entry per line at most):
$template_lines

The ONLY source content you may use — this deal's extracted document locations:
$locations

Return ONLY a JSON object shaped exactly like this and nothing else:
{"line_items": [
   {"line_item_key": "<template key>",
    "value": <number, no commas, no currency symbol>,
    "document_id": <the document id the figure stands in>,
    "document_location_id": <the document location id the figure stands in>,
    "period": "<the statement period, e.g. FY2025>"}
 ],
 "unsupported_line_items": ["<template key the documents cannot support>"],
 "rationale": "<one or two sentences, drawn only from the record>"}

Every figure MUST carry the document id and document location id it came from;
an uncited figure is invalid output. Never invent a line item, never carry a
number over from another deal, and never compute DSCR, leverage or the current
ratio — those are calculated by the system, not by you. For any template line
the documents cannot support, list the key under unsupported_line_items and use
the exact phrase "not supported by the record" in your rationale."""

prompts.register(SPREAD_PROMPT_NAME, SPREAD_PROMPT_TEXT, version=SPREAD_PROMPT_VERSION)


def build_spread_prompt(deal: dict, facts: dict) -> str:
    template_lines = "\n".join(
        f"- {line['key']} ({CATEGORY_LABELS[line['category']]}): {line['label']}" for line in SPREAD_TEMPLATE
    )
    locations = (
        "\n".join(
            f"- location {loc['id']} (document {loc['document_id']} · "
            f"{facts['documents_by_id'].get(loc['document_id'], {}).get('original_filename')} · "
            f"page {loc['page_number']} · {loc['section']}): {str(loc.get('extracted_text') or '')[:MAX_EXCERPT]}"
            for loc in facts["locations"][:120]
        )
        or "- none extracted for this deal"
    )
    return prompts.render(
        SPREAD_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        facility_type=deal.get("facility_type") or "",
        template_lines=template_lines,
        locations=locations,
    )


def spread_run_inputs(deal: dict, facts: dict) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": [d["id"] for d in facts["documents"]],
        "document_location_ids": [loc["id"] for loc in facts["locations"]],
        "template_keys": list(TEMPLATE_KEYS),
        "template_version": SPREAD_TEMPLATE_VERSION,
    }


def captioned_amounts(text: str, key: str) -> list[float]:
    """Every amount the location states UNDER THIS TEMPLATE LINE's caption.

    The agent path is validated with the same matchers the deterministic reader
    uses, so it can only ever be a stricter reading of the record — never a
    looser one.
    """
    amounts = []
    for pattern, _ in _MATCHERS.get(key, []):
        for match in pattern.finditer(str(text or "")):
            value = parse_amount(match.group(1))
            if value is not None:
                amounts.append(value)
    return amounts


def parse_spread_reply(reply: str, facts: dict) -> dict | None:
    """Accept the agent's figures only where the record backs them.

    A proposed figure survives only if (a) its key is on the template, (b) the
    location it cites belongs to THIS deal, (c) the document id it names is the
    location's own document, and (d) the cited location states that exact
    amount UNDER THAT TEMPLATE LINE's own caption.

    (d) is compared as a parsed number against the captioned figure — never as a
    run of digits, which would let "1,420,000" license 14,200.00, 142 or its own
    negation — and the caption anchoring means a figure cannot be re-keyed onto
    a line it was never stated for (revenue reported as annual debt service, the
    input that would move DSCR). Money the model invented, mis-keyed, read off a
    neighbouring line, or was told to report by text planted in a borrower
    document cannot get through: it still has to stand under the caption it
    claims, in the location it cites.
    """
    for blob in uw.json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict) or not isinstance(parsed.get("line_items"), list):
            continue
        items: dict = {}
        for raw in parsed["line_items"]:
            if not isinstance(raw, dict):
                continue
            key = raw.get("line_item_key")
            if key not in TEMPLATE_BY_KEY or key in items:
                continue
            location = facts["locations_by_id"].get(raw.get("document_location_id"))
            if location is None:
                continue
            document = facts["documents_by_id"].get(location["document_id"])
            if document is None or raw.get("document_id") not in (None, document["id"]):
                continue
            value = parse_amount(raw.get("value"))
            if value is None:
                continue
            if value not in captioned_amounts(location.get("extracted_text"), key):
                continue  # the cited location does not state this amount for this line
            # The period is derived from the document, never taken from the
            # model: a figure read out of an FY2024 comparative column must not
            # be able to label itself FY2025 on the strength of the model saying so.
            period = _period_for(
                [r.get("extracted_text") for r in facts["by_document"].get(document["id"], [])]
                + [document.get("original_filename")]
            )
            items[key] = {
                "value": value,
                "period": period,
                "caption": TEMPLATE_BY_KEY[key]["label"],
                # bounded: the model's own rendering of the figure is stored on
                # the citation row, so it is length-capped like every other
                # stored free-text field
                "citation": _citation_from(document, location, str(raw.get("value"))[:40]),
            }
        if not items:
            continue
        return {"items": items, "rationale": str(parsed.get("rationale") or "")[:600]}
    return None


def _coverage(line_items: list[dict]) -> dict:
    """What the reviewer is being asked to trust, counted honestly: a figure a
    human typed in has a citation, but it is not a document citation."""
    supported = [i for i in line_items if i.get("supported")]
    document_cited = [
        i for i in supported if (i.get("citation") or {}).get("source_type") == "document_location"
    ]
    human_entered = [
        i for i in supported if (i.get("citation") or {}).get("source_type") == "human_entry"
    ]
    return {
        "template_lines": len(SPREAD_TEMPLATE),
        "supported": len(supported),
        "unsupported": len([i for i in line_items if not i.get("supported")]),
        "document_cited": len(document_cited),
        "human_entered": len(human_entered),
        # every persisted figure carries a citation by construction
        "uncited_figures": len([i for i in supported if not i.get("citation")]),
    }


def build_spread_content(deal: dict, reply: str, facts: dict) -> dict:
    """Merge what the agent could prove against the record with the app's own
    deterministic reading; every remaining template line says so plainly."""
    proposal = parse_spread_reply(reply, facts) or {"items": {}, "rationale": ""}
    agent_items = proposal["items"]
    derived = extract_figures(facts)

    line_items: list[dict] = []
    citations: list[dict] = []
    unsupported: list[str] = []
    conflicted: list[str] = []
    for line in SPREAD_TEMPLATE:
        key = line["key"]
        record = derived.get(key)
        hit = agent_items.get(key)
        source = "agent"
        # The agent may only confirm what the record states. If the app's own
        # reading of the same line disagrees with the figure the agent proposes,
        # that is a conflict in the evidence, not a tie for the model to break.
        if hit is not None and record is not None:
            if record.get("conflict") or record["value"] != hit["value"]:
                hit = None
        if hit is None:
            hit = record
            source = "deterministic-fallback"
        if hit is not None and hit.get("conflict"):
            conflicted.append(key)
            hit = None
        entry = {
            "line_item_key": key,
            "category": line["category"],
            "category_label": CATEGORY_LABELS[line["category"]],
            "label": line["label"],
            "unit": "USD",
        }
        if hit is None:
            unsupported.append(key)
            readings = (derived.get(key) or {}).get("conflict") or []
            entry.update(
                {
                    "value": None,
                    "period": None,
                    "supported": False,
                    "statement": NOT_SUPPORTED,
                    "source": "record",
                    "citation": None,
                }
            )
            if readings:
                entry["conflict"] = [
                    {
                        "value": reading["value"],
                        "source_reference": reading["citation"]["source_reference"],
                        "excerpt": reading["citation"]["excerpt"],
                    }
                    for reading in readings
                ]
                entry["statement"] = (
                    "the record states more than one figure for this line ("
                    + "; ".join(f"{reading['value']:,.2f}" for reading in readings)
                    + ") — " + NOT_SUPPORTED + " until a named human resolves it"
                )
        else:
            citation = dict(hit["citation"], line_item_key=key)
            entry.update(
                {
                    "value": hit["value"],
                    "period": hit["period"],
                    "supported": True,
                    "statement": None,
                    "source": source,
                    "citation": citation,
                }
            )
            citations.append(citation)
        line_items.append(entry)

    supported = [i for i in line_items if i["supported"]]
    sources = {i["source"] for i in supported}
    if not supported:
        overall = "record"
    elif len(sources) == 1:
        overall = next(iter(sources))
    else:
        overall = "mixed"
    rationale = proposal["rationale"] or (
        f"{len(supported)} of {len(SPREAD_TEMPLATE)} template lines are supported by "
        f"{len(facts['documents'])} document(s) across {len(facts['locations'])} extracted locations; "
        f"the remaining lines are {NOT_SUPPORTED}."
        if facts["locations"]
        else f"No extractable document locations are on file for this deal, so every template line is {NOT_SUPPORTED}."
    )
    return {
        "template_version": SPREAD_TEMPLATE_VERSION,
        "spread_line_items": line_items,
        "citations": citations,
        "unsupported_line_items": unsupported,
        "conflicted_line_items": conflicted,
        "coverage": _coverage(line_items),
        "documents_on_file": len(facts["documents"]),
        "document_location_count": len(facts["locations"]),
        "source": overall,
        "rationale": rationale,
    }


# --------------------------------------------------------------------------
# Parking the PENDING draft (the human gate)
# --------------------------------------------------------------------------


def _park_spread_draft(deal: dict, content: dict, agent_run_id, actor_user_id: str) -> dict:
    approval_item = uw.human_gate_for(deal, "spread", content)
    draft = store.insert(
        "agent_drafts",
        {
            "agent_run_id": agent_run_id,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "draft_type": "spread",
            "draft_content": content,
            "review_status": "pending",
            "reviewed_by_user_id": None,
            "review_action": None,
            "review_reason": None,
            "human_edits": None,
            "created_at": uw.now_iso(),
            "reviewed_at": None,
            "approval_item_id": approval_item["id"],
        },
    )
    uw.touch_deal(deal)
    uw.audit_event(
        event_type="agent_draft.created",
        action="financial spread draft created (pending human acceptance)",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="agent_drafts",
        entity_id=draft["id"],
        new_values={
            "draft_type": "spread",
            "review_status": "pending",
            "agent_run_id": agent_run_id,
            "supported_line_items": content["coverage"]["supported"],
        },
    )
    return draft


def adopt_workflow_spread(deal: dict, actor_user_id: str) -> dict | None:
    """Adopt the `spread_financials` node's OWN output as the pending draft.

    The approved process already ran the spreading agent inside the run when the
    triage gate was accepted. Re-prompting here would double the cost and mean
    the draft a human reviews is not the output the process produced.
    """
    run_id = deal.get("workflow_run_id")
    # Adopt the node's output ONCE. A deal that already has a spread draft has
    # had this reply in front of a human — re-adopting it after a rejection
    # would hand the reviewer back the very draft they refused, over a fresh
    # agent-run row for a model call that never happened. A re-spread runs the
    # agent again, with this app's own prompt.
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
    run = uw.record_agent_run(
        deal=deal,
        agent_type="financial_spreading",
        agent_name=SPREAD_AGENT_NAME,
        run_stage=SPREAD_STAGE,
        prompt_name=SPREAD_PROMPT_NAME,
        prompt=build_spread_prompt(deal, facts),
        reply=reply,
        inputs=spread_run_inputs(deal, facts) | {"workflow_run_id": run_id, "workflow_node": "spread_financials"},
        # wall clock of the workflow tick this agent node dominated; the engine
        # exposes no per-node timing, so the measured tick is what is recorded.
        latency_ms=int(deal.get("last_workflow_tick_ms") or 0),
        prompt_source="workflow node deal-underwriting/spread_financials (see workflows/workflows.json)",
    )
    content = build_spread_content(deal, reply, facts)
    if _needs_strict_reask(content, facts):
        # The process definition's node prompt is prose, not the strict schema
        # this app validates against, so a live model's node reply can be
        # unusable as structured figures. Rather than quietly reviewing a
        # deterministic reading while the record implies an agent spread, the
        # run stays on file (REQ-038) and the caller re-asks the agent with the
        # app's own schema-bearing prompt.
        uw.log("spread.reask", deal_reference=deal["deal_reference"], reason="workflow node reply carried no usable figure")
        return None
    return _park_spread_draft(deal, content, run["id"], actor_user_id)


def _needs_strict_reask(content: dict, facts: dict) -> bool:
    """True when the adopted reply yielded no agent figure although the record
    has locations to read — and a re-ask could actually do better.

    In stub mode it never can (the deterministic responder echoes whatever it is
    given), so the app does not spend a second call to prove that.
    """
    if not facts["locations"]:
        return False
    if any(item.get("source") == "agent" for item in content.get("spread_line_items") or []):
        return False
    try:
        return agent_runtime.mode()["mode"] != "stub"
    except Exception:
        return False


def build_spread_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the spreading agent directly and park the result as a PENDING draft.

    Used when there is no unconsumed workflow output to adopt — a re-spread
    after a rejection, say. Nothing here persists a figure or moves a stage.
    """
    facts = spread_facts(deal)
    outcome = uw.run_agent(
        agent_name=SPREAD_AGENT_NAME,
        prompt=build_spread_prompt(deal, facts),
        deal=deal,
        agent_type="financial_spreading",
        run_stage=SPREAD_STAGE,
        prompt_name=SPREAD_PROMPT_NAME,
        inputs=spread_run_inputs(deal, facts),
    )
    return _park_spread_draft(deal, build_spread_content(deal, outcome["reply"], facts), outcome["run"]["id"], actor_user_id)


def start_spread(deal: dict, actor: dict) -> dict:
    """The Draft Review workspace's 'run the spreading agent' action."""
    stage = deal.get("current_stage")
    if stage not in (SPREAD_START_STAGE, SPREAD_STAGE):
        if stage == "intake":
            raise uw.DomainError(
                409,
                f"deal {deal['deal_reference']} is still at intake — the intake triage draft must be "
                "accepted by a named human before the financial spread can be drafted",
            )
        raise uw.DomainError(
            409,
            f"deal {deal['deal_reference']} is at '{stage}'; the financial spread is drafted at "
            f"'{SPREAD_START_STAGE}'",
        )
    draft = uw.pending_draft(deal["id"], "spread")
    created = False
    if draft is None:
        draft = adopt_workflow_spread(deal, actor["username"]) or build_spread_draft(deal, actor["username"])
        created = True
    # Spreading has started: the deal moves onto the spreading stage. The stage
    # move is an activity record, not an acceptance — the draft stays PENDING.
    if deal.get("current_stage") == SPREAD_START_STAGE:
        uw.record_transition(deal, SPREAD_STAGE, actor["username"], reason="financial spreading agent run")
    return {"draft": draft, "created": created}


# --------------------------------------------------------------------------
# Promotion — human acceptance is what turns figures into deal-of-record data
# --------------------------------------------------------------------------


def persisted_line_items(deal_id, *, include_superseded: bool = False) -> list[dict]:
    """The deal's spread of record. Superseded rows are kept (nothing in the
    record is deleted) but are not the spread any more."""
    rows = [r for r in store.list("spread_line_items") if r.get("deal_id") == deal_id]
    if include_superseded:
        return rows
    return [r for r in rows if not r.get("superseded_at")]


def citations_for(deal_id, *, include_superseded: bool = False) -> list[dict]:
    rows = [r for r in store.list("citations") if r.get("deal_id") == deal_id]
    if include_superseded:
        return rows
    live = {r["id"] for r in persisted_line_items(deal_id)}
    return [r for r in rows if r.get("spread_line_item_id") in live]


def persist_spread(deal: dict, content: dict, actor_user_id: str, draft_id=None) -> dict:
    """Write the accepted spread as structured line items with their citations.

    Idempotent per draft: the workflow node and the review endpoint both land
    here for the SAME accepted draft, and a replayed run must not double the
    deal's spread. A *different* accepted draft supersedes the spread of record
    rather than being silently discarded — the superseded rows stay on file and
    the supersession is audited.
    """
    existing = persisted_line_items(deal["id"])
    if existing and (draft_id is None or all(r.get("source_draft_id") == draft_id for r in existing)):
        audit = uw.audit_event(
            event_type="spread.already_persisted",
            action=f"{len(existing)} spread line item(s) already on file for this accepted draft; nothing re-written",
            actor_user_id=actor_user_id,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            new_values={"spread_line_item_count": len(existing), "source_draft_id": draft_id},
        )
        item_ids = [r["id"] for r in existing]
        return {
            "spread_line_item_ids": item_ids,
            "citation_ids": [c["id"] for c in citations_for(deal["id"]) if c.get("spread_line_item_id") in set(item_ids)],
            "audit_log_id": audit["id"],
            "replayed": True,
        }
    if existing:
        superseded_at = uw.now_iso()
        for row in existing:
            before = dict(row)
            row["superseded_at"] = superseded_at
            row["superseded_by_user_id"] = actor_user_id
            row["superseded_by_draft_id"] = draft_id
            uw.save_row("spread_line_items", row, actor_user_id=actor_user_id, before=before)
        uw.audit_event(
            event_type="spread.superseded",
            action=f"{len(existing)} spread line item(s) superseded by a later accepted spread draft",
            actor_user_id=actor_user_id,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            old_values={"spread_line_item_ids": [r["id"] for r in existing]},
            new_values={"superseded_by_draft_id": draft_id},
        )

    item_ids: list[int] = []
    citation_ids: list[int] = []
    for entry in content.get("spread_line_items") or []:
        if not entry.get("supported") or entry.get("value") is None:
            continue  # a line the record cannot support is never invented into the spread
        row = store.insert(
            "spread_line_items",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "line_item_key": entry["line_item_key"],
                "category": entry["category"],
                "label": entry["label"],
                "value": entry["value"],
                "unit": entry.get("unit") or "USD",
                "period": entry.get("period"),
                "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
                "value_source": entry.get("source"),
                "source_draft_id": draft_id,
                "accepted_by_user_id": actor_user_id,
                "accepted_at": uw.now_iso(),
                "superseded_at": None,
            },
        )
        item_ids.append(row["id"])
        citation = entry.get("citation") or {}
        citation_row = store.insert(
            "citations",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "cited_value": str(citation.get("cited_value") if citation.get("cited_value") is not None else entry["value"]),
                "source_type": citation.get("source_type") or "human_entry",
                "source_reference": citation.get("source_reference") or f"entered by {actor_user_id}",
                "document_id": citation.get("document_id"),
                "document_location_id": citation.get("document_location_id"),
                "spread_line_item_id": row["id"],
                "ratio_id": None,
                "policy_rule_id": None,
                "created_at": uw.now_iso(),
            },
        )
        citation_ids.append(citation_row["id"])

    audit = uw.audit_event(
        event_type="spread.persisted",
        action=f"accepted financial spread persisted as {len(item_ids)} cited line item(s)",
        actor_user_id=actor_user_id,
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="spread_line_items",
        new_values={
            "spread_line_item_ids": item_ids,
            "citation_ids": citation_ids,
            "unsupported_line_items": content.get("unsupported_line_items", []),
            "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
        },
    )
    return {
        "spread_line_item_ids": item_ids,
        "citation_ids": citation_ids,
        "audit_log_id": audit["id"],
        "replayed": False,
    }


def promote_spread(deal: dict, content: dict, actor: dict, draft: dict | None = None) -> dict:
    result = persist_spread(deal, content, actor["username"], draft_id=(draft or {}).get("id"))
    return {
        "spread_line_item_ids": result["spread_line_item_ids"],
        "citation_ids": result["citation_ids"],
        "spread_line_items": [
            {k: v for k, v in row.items()} for row in persisted_line_items(deal["id"])
        ],
        "template_version": content.get("template_version", SPREAD_TEMPLATE_VERSION),
        "unsupported_line_items": content.get("unsupported_line_items", []),
    }


def edit_spread(content: dict, edits: dict) -> dict:
    """'Edit & accept' on a figure.

    A human may correct a figure the agent read wrongly. The edit is recorded as
    a diff against the agent original and the corrected figure is re-cited to the
    named human — it never keeps a document citation it no longer stands on.
    """
    raw = edits.get("line_items")
    if raw is None:
        return {}
    if not isinstance(raw, dict) or not raw:
        raise uw.DomainError(400, "line_items edits must be an object of {line_item_key: value}")
    if len(raw) > len(SPREAD_TEMPLATE):
        raise uw.DomainError(400, "too many edited line items")
    editor = str(edits.get("edited_by") or "the reviewer")
    applied: dict = {}
    by_key = {entry["line_item_key"]: entry for entry in content.get("spread_line_items") or []}
    for key, value in raw.items():
        entry = by_key.get(key)
        if entry is None:
            raise uw.DomainError(400, f"'{key}' is not a line on {SPREAD_TEMPLATE_VERSION}")
        if value in (None, ""):
            before = entry.get("value")
            entry.update({"value": None, "supported": False, "statement": NOT_SUPPORTED, "source": "human-edited", "citation": None, "period": None})
            applied[key] = {"from": before, "to": None}
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise uw.DomainError(400, f"the edited value for '{key}' must be a number")
        amount = parse_amount(value)
        if amount is None:
            raise uw.DomainError(400, f"the edited value for '{key}' must be a number")
        if abs(amount) > uw.MAX_REQUESTED_AMOUNT:
            raise uw.DomainError(400, f"the edited value for '{key}' is outside the accepted range")
        before = entry.get("value")
        entry.update(
            {
                "value": amount,
                "supported": True,
                "statement": None,
                "source": "human-edited",
                # the document period went with the citation the correction
                # replaced; a corrected figure states no period of its own
                "period": None,
                "citation": {
                    "document_id": None,
                    "document_location_id": None,
                    "source_type": "human_entry",
                    "source_reference": f"corrected at the draft review gate by {editor}",
                    "document_filename": None,
                    "page_number": None,
                    "section": None,
                    "excerpt": f"agent read {before}; corrected to {amount} by {editor}",
                    "cited_value": str(amount),
                    "line_item_key": key,
                },
            }
        )
        applied[key] = {"from": before, "to": amount}

    if not applied:
        return {}
    supported = [i for i in content["spread_line_items"] if i.get("supported")]
    content["citations"] = [i["citation"] for i in supported if i.get("citation")]
    content["unsupported_line_items"] = [i["line_item_key"] for i in content["spread_line_items"] if not i.get("supported")]
    content["coverage"] = _coverage(content["spread_line_items"])
    return {"line_items": applied}


uw.DRAFT_PROMOTERS["spread"] = promote_spread
uw.DRAFT_EDITORS["spread"] = edit_spread


# --------------------------------------------------------------------------
# Workflow handler — workflows.json / deal-underwriting / persist_spread
# --------------------------------------------------------------------------


def handler_persist_spread_line_items(context: dict) -> dict:
    deal = uw.workflow_deal(context)
    draft = None
    for row in reversed(uw.drafts_for(deal["id"], "spread")):
        if row.get("review_status") in ("accepted", "edited"):
            draft = row
            break
    if draft is None:
        raise workflow_engine.WorkflowError("the financial spread has not been accepted by a named human")
    actor_username = draft.get("reviewed_by_user_id") or deal.get("submitted_by_user_id")
    result = persist_spread(deal, draft["draft_content"], actor_username, draft_id=draft["id"])
    return {
        "deal_id": deal["deal_reference"],
        "spread_line_item_ids": result["spread_line_item_ids"],
        "citation_ids": result["citation_ids"],
        "reviewed_by_user_id": actor_username,
        "audit_log_id": result["audit_log_id"],
    }


def register_handlers() -> None:
    uw.register_workflow_handler("persist_spread_line_items", handler_persist_spread_line_items)


register_handlers()


# --------------------------------------------------------------------------
# Read model for the Draft Review workspace
# --------------------------------------------------------------------------


def spread_view(deal: dict) -> dict:
    """The deal's spread of record — persisted line items with their citations."""
    rows = persisted_line_items(deal["id"])
    citations = {c.get("spread_line_item_id"): c for c in citations_for(deal["id"])}
    items = []
    for row in rows:
        citation = citations.get(row["id"]) or {}
        items.append(
            dict(
                row,
                category_label=CATEGORY_LABELS.get(row.get("category"), row.get("category")),
                citation_id=citation.get("id"),
                source_reference=citation.get("source_reference"),
                document_location_id=citation.get("document_location_id"),
            )
        )
    keys = {row.get("line_item_key") for row in rows}
    return {
        "deal_reference": deal["deal_reference"],
        "template_version": SPREAD_TEMPLATE_VERSION,
        "spread_line_items": items,
        "citations": [c for c in citations_for(deal["id"]) if c.get("spread_line_item_id")],
        "unsupported_line_items": [key for key in TEMPLATE_KEYS if key not in keys],
        "is_of_record": bool(rows),
    }
