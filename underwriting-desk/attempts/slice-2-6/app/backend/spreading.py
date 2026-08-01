"""Financial spreading (slice 2) — the spread draft, its citations, and the
human gate that promotes it into deal-of-record data.

Composition contract honoured here (same as the slice-1 core):
  * every read/write goes through ``db.store`` (tables from ``models.TABLES``)
  * the LLM call goes through ``uw.run_agent`` -> ``agent_runtime.respond()``
  * agent output lands in a PENDING ``agent_drafts`` row that a named human
    must accept; acceptance is the only act that writes ``spread_line_items``
  * every figure that reaches the deal of record carries a citation row naming
    the document AND the document location it came from — an uncited figure is
    refused, not stored
  * no ratio, grade, tier or other derived money value is produced here; the
    spread is extraction only (REQ-009 keeps ratios in deterministic code)
"""
from __future__ import annotations

import json
import re

import citations as citation_envelope
import costmeter
import pii
import prompts
import underwriting as uw
import workflow_engine
from db import store

# --------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------

SPREAD_TEMPLATE_VERSION = "spread-template@2026.1"
SPREAD_PROMPT_NAME = "financial_spread"
SPREAD_PROMPT_VERSION = 1
SPREAD_AGENT_NAME = "Financial Spreading Agent"

#: Deny by default (FSI hardening rule 4): only these roles may run the
#: spreading agent. The draft-review gate keeps its own role set in uw.
SPREAD_ROLES = frozenset({"credit_analyst", "credit_officer"})

#: The spread is drafted once the accepted triage has moved the deal off
#: intake; accepting it advances the deal to risk grading.
SPREAD_FROM_STAGES = ("document_extraction", "financial_spreading")
SPREAD_WORKING_STAGE = "financial_spreading"
SPREAD_TO_STAGE = "risk_grading"

NOT_SUPPORTED = "not supported by the record"

#: The bank's standard spread template. Keys are stable ids (they are what a
#: citation and, in a later slice, a ratio hangs off); `patterns` are the label
#: forms a statement may use for that line. Nothing derived lives here — every
#: line is a figure a document either states or does not.
TEMPLATE = (
    {
        "key": "revenue",
        "label": "Revenue / net sales",
        "category": "income_statement",
        "patterns": (r"total\s+revenues?", r"net\s+sales", r"gross\s+receipts", r"revenues?", r"sales"),
    },
    {
        "key": "cost_of_goods_sold",
        "label": "Cost of goods sold",
        "category": "income_statement",
        "patterns": (r"cost\s+of\s+goods\s+sold", r"cost\s+of\s+sales", r"cogs"),
    },
    {
        "key": "operating_expenses",
        "label": "Operating expenses",
        "category": "income_statement",
        "patterns": (r"total\s+operating\s+expenses", r"operating\s+expenses", r"sg&a", r"selling,?\s+general"),
    },
    {
        "key": "ebitda",
        "label": "EBITDA",
        "category": "income_statement",
        "patterns": (r"ebitda",),
    },
    {
        "key": "depreciation_amortization",
        "label": "Depreciation & amortisation",
        "category": "income_statement",
        "patterns": (r"depreciation\s+and\s+amorti[sz]ation", r"depreciation", r"amorti[sz]ation"),
    },
    {
        "key": "interest_expense",
        "label": "Interest expense",
        "category": "income_statement",
        "patterns": (r"interest\s+expense",),
    },
    {
        "key": "net_income",
        "label": "Net income",
        "category": "income_statement",
        "patterns": (r"net\s+income", r"net\s+profit", r"net\s+earnings"),
    },
    {
        "key": "current_assets",
        "label": "Total current assets",
        "category": "balance_sheet",
        "patterns": (r"total\s+current\s+assets", r"current\s+assets"),
    },
    {
        "key": "current_liabilities",
        "label": "Total current liabilities",
        "category": "balance_sheet",
        "patterns": (r"total\s+current\s+liabilities", r"current\s+liabilities"),
    },
    {
        "key": "total_debt",
        "label": "Total funded debt",
        "category": "balance_sheet",
        # "total debt service" is the debt-service line, not the debt balance.
        "patterns": (r"total\s+funded\s+debt", r"funded\s+debt", r"total\s+debt(?!\s+service)"),
    },
    {
        "key": "tangible_net_worth",
        "label": "Tangible net worth",
        "category": "balance_sheet",
        "patterns": (r"tangible\s+net\s+worth",),
    },
    {
        "key": "annual_debt_service",
        "label": "Annual debt service",
        "category": "debt_service",
        "patterns": (
            r"annual\s+debt\s+service",
            r"total\s+debt\s+service",
            r"annual\s+principal\s+and\s+interest",
            r"principal\s+and\s+interest",
        ),
    },
)

TEMPLATE_KEYS = tuple(spec["key"] for spec in TEMPLATE)
TEMPLATE_BY_KEY = {spec["key"]: spec for spec in TEMPLATE}

#: Which document a figure is preferably taken from when several state it. An
#: audited statement outranks a tax return; both outrank a schedule.
DOCUMENT_PRIORITY = (
    "financial_statements",
    "interim_financials",
    "business_tax_return",
    "personal_tax_return",
    "debt_schedule",
    "ar_aging",
    "ap_aging",
    "bank_statements",
    "personal_financial_statement",
)

#: A human correction may move at most this far from a stated figure without
#: being a different number entirely — bounded like every other edge input.
MAX_LINE_VALUE = 1e15


# --------------------------------------------------------------------------
# Deterministic extraction from citable document locations
# --------------------------------------------------------------------------

_AMOUNT_RE = re.compile(r"\(?\$?\s*-?\d[\d,]*(?:\.\d{1,2})?\)?")
_PERIOD_RES = (
    re.compile(r"\bFY\s?(20\d{2})\b", re.I),
    re.compile(r"tax\s+year\s+(20\d{2})", re.I),
    re.compile(r"\b(20\d{2})\b"),
)
#: How far past a template label the figure may sit before the match is
#: considered unrelated text rather than that line's amount.
_AMOUNT_WINDOW = 48


def _document_rank(document: dict) -> int:
    try:
        return DOCUMENT_PRIORITY.index(document.get("document_type"))
    except ValueError:
        return len(DOCUMENT_PRIORITY)


def parse_amount(raw: str) -> float | None:
    text = str(raw or "").strip()
    negative = text.startswith("(") and text.endswith(")")
    digits = re.sub(r"[^0-9.\-]", "", text)
    if digits in ("", "-", ".", "-."):
        return None
    try:
        value = float(digits)
    except ValueError:
        return None
    if abs(value) > MAX_LINE_VALUE:
        return None
    return -value if negative else value


def _location_text(location: dict) -> str:
    section = str(location.get("section") or "").strip()
    text = str(location.get("extracted_text") or "").strip()
    return f"{section}: {text}" if section and section.lower() != "body" else text


def find_line_value(spec: dict, text: str) -> float | None:
    """First amount stated after one of this template line's labels."""
    for pattern in spec["patterns"]:
        for match in re.finditer(r"\b" + pattern + r"\b", text, re.I):
            window = text[match.end() : match.end() + _AMOUNT_WINDOW]
            found = _AMOUNT_RE.search(window)
            if not found:
                continue
            value = parse_amount(found.group(0))
            if value is not None:
                return value
    return None


def _period_for(document_id, locations: list[dict]) -> str:
    for location in locations:
        if location.get("document_id") != document_id:
            continue
        for pattern in _PERIOD_RES:
            match = pattern.search(str(location.get("extracted_text") or ""))
            if match:
                return "FY" + match.group(1)
    return "as stated"


def spread_facts(deal: dict) -> dict:
    """Everything the spread may be drawn from: this deal's documents and the
    citable locations extracted from them. Nothing else is in scope."""
    document_rows = uw.documents_for(deal["id"])
    locations = uw.locations_for([d["id"] for d in document_rows])
    ordered_documents = sorted(document_rows, key=lambda d: (_document_rank(d), d["id"]))
    order = {d["id"]: index for index, d in enumerate(ordered_documents)}
    ordered_locations = sorted(
        locations, key=lambda loc: (order.get(loc.get("document_id"), 999), loc.get("document_id") or 0, loc["id"])
    )
    return {
        "document_rows": document_rows,
        "ordered_documents": ordered_documents,
        "documents_by_id": {d["id"]: d for d in document_rows},
        "locations": locations,
        "ordered_locations": ordered_locations,
        "locations_by_id": {loc["id"]: loc for loc in locations},
    }


def _citation_for(location: dict, document: dict, value: float) -> dict:
    excerpt = str(location.get("extracted_text") or "")[:240]
    name = document.get("original_filename") or f"document {document.get('id')}"
    return {
        "source_type": "document_location",
        "document_id": document.get("id"),
        "document_location_id": location.get("id"),
        "document_name": name,
        "document_type": document.get("document_type"),
        "page_number": location.get("page_number"),
        "section": location.get("section"),
        "excerpt": excerpt,
        "source_reference": f"{name} · p.{location.get('page_number')} · {location.get('section')}",
        "cited_value": format_value(value),
    }


def format_value(value) -> str:
    if value is None:
        return NOT_SUPPORTED
    number = float(value)
    if number == int(number):
        return f"{int(number):,}"
    return f"{number:,.2f}"


def _empty_line(spec: dict, period: str = "as stated") -> dict:
    return {
        "line_item_key": spec["key"],
        "label": spec["label"],
        "category": spec["category"],
        "unit": "USD",
        "period": period,
        "value": None,
        "value_display": NOT_SUPPORTED,
        "evidence_status": "not_supported",
        "note": NOT_SUPPORTED,
        "citation": None,
    }


def derive_spread(facts: dict) -> list[dict]:
    """Deterministic fill of the template straight from the record.

    Used when the agent's structured reply does not validate (and it is what
    the offline responder always falls back to). Every figure it produces is
    the literal text of a stored document location, so the citation is exact.
    """
    items: list[dict] = []
    for spec in TEMPLATE:
        item = _empty_line(spec)
        for location in facts["ordered_locations"]:
            document = facts["documents_by_id"].get(location.get("document_id"))
            if document is None:
                continue
            value = find_line_value(spec, _location_text(location))
            if value is None:
                continue
            item = {
                "line_item_key": spec["key"],
                "label": spec["label"],
                "category": spec["category"],
                "unit": "USD",
                "period": _period_for(document["id"], facts["locations"]),
                "value": value,
                "value_display": format_value(value),
                "evidence_status": "cited",
                "note": None,
                "citation": _citation_for(location, document, value),
            }
            break
        items.append(item)
    return items


# --------------------------------------------------------------------------
# The spreading agent (roster agent 2) — extracts, never computes
# --------------------------------------------------------------------------

SPREAD_PROMPT_TEXT = """Deal reference: $deal_reference
Borrower: $borrower_name

You may use NOTHING except the document locations listed below. They are the
only evidence on file for this deal.

$location_catalog

Standard spread template lines (use the key exactly, once each):
$template_lines

Return ONLY a JSON object shaped exactly like this and nothing else:
{"line_items": [
  {"line_item_key": "<template key>",
   "value": <number or null>,
   "period": "<period the figure covers, or 'as stated'>",
   "document_id": <id of the document the figure came from, or null>,
   "document_location_id": <id of the location the figure came from, or null>,
   "note": "<'%s' when the documents do not state this line, otherwise null>"}
]}

Rules: every numeric value MUST carry the document_id and document_location_id
it was read from, and the figure must appear verbatim in that location's text —
an uncited or unverifiable figure is invalid output. Never invent a line item,
never carry a number over from memory or another deal, and never compute DSCR,
leverage, or the current ratio: those are calculated by the system. Where the
documents do not support a template line, set value to null and write exactly
"%s" in note.""" % (NOT_SUPPORTED, NOT_SUPPORTED)

prompts.register(SPREAD_PROMPT_NAME, SPREAD_PROMPT_TEXT, version=SPREAD_PROMPT_VERSION)


def build_prompt(deal: dict, facts: dict) -> str:
    catalog_lines = []
    for location in facts["ordered_locations"][:120]:
        document = facts["documents_by_id"].get(location.get("document_id")) or {}
        catalog_lines.append(
            "- location {loc} (document {doc} \"{name}\", type {type}, page {page}, section {section}): \"{text}\"".format(
                loc=location["id"],
                doc=document.get("id"),
                name=document.get("original_filename"),
                type=document.get("document_type"),
                page=location.get("page_number"),
                section=location.get("section"),
                text=str(location.get("extracted_text") or "")[:200],
            )
        )
    template_lines = "\n".join(f"- {spec['key']}: {spec['label']} ({spec['category']}, USD)" for spec in TEMPLATE)
    return prompts.render(
        SPREAD_PROMPT_NAME,
        deal_reference=deal["deal_reference"],
        borrower_name=deal["borrower_name"],
        location_catalog="\n".join(catalog_lines) or "- no extracted document locations are on file for this deal",
        template_lines=template_lines,
    )


def run_inputs(deal: dict, facts: dict) -> dict:
    return {
        "deal_reference": deal["deal_reference"],
        "document_ids": [d["id"] for d in facts["document_rows"]],
        "document_location_ids": [loc["id"] for loc in facts["locations"]],
        "template_keys": list(TEMPLATE_KEYS),
        "template_version": SPREAD_TEMPLATE_VERSION,
    }


def _digits(value) -> str:
    return re.sub(r"[^0-9]", "", str(value))


def parse_spread_reply(reply: str, facts: dict) -> list[dict] | None:
    """Accept the agent's structured spread only if every part of it validates.

    Validation is deliberately strict: each template line exactly once, every
    figure carrying a document id AND a location id that belong to this deal,
    and the figure's digits actually present in that location's stored text.
    A citation the record cannot confirm is a hallucinated citation, so the
    whole reply is rejected and the deterministic derivation is used instead.
    """
    for blob in uw.json_candidates(reply or ""):
        try:
            parsed = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict) or not isinstance(parsed.get("line_items"), list):
            continue
        items: dict[str, dict] = {}
        ok = True
        for raw in parsed["line_items"]:
            if not isinstance(raw, dict):
                ok = False
                break
            key = raw.get("line_item_key")
            spec = TEMPLATE_BY_KEY.get(key)
            if spec is None or key in items:
                ok = False
                break
            value = raw.get("value")
            if value is None:
                items[key] = _empty_line(spec, str(raw.get("period") or "as stated")[:40])
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or abs(float(value)) > MAX_LINE_VALUE:
                ok = False
                break
            location = facts["locations_by_id"].get(raw.get("document_location_id"))
            document = facts["documents_by_id"].get(raw.get("document_id"))
            if location is None or document is None or location.get("document_id") != document.get("id"):
                ok = False
                break
            # The cited location must state THIS template line at THIS figure.
            # A digits-appear-somewhere test is not evidence: "12,400,000"
            # contains "400,000", and a location about revenue says nothing
            # about EBITDA. Reading the line out of the cited text with the
            # same deterministic rule the fallback uses is what makes the
            # citation checkable by a person holding the document.
            stated = find_line_value(spec, _location_text(location))
            if stated is None or abs(stated - float(value)) > 0.005:
                ok = False
                break
            items[key] = {
                "line_item_key": key,
                "label": spec["label"],
                "category": spec["category"],
                "unit": "USD",
                "period": str(raw.get("period") or _period_for(document["id"], facts["locations"]))[:40],
                "value": float(value),
                "value_display": format_value(value),
                "evidence_status": "cited",
                "note": None,
                "citation": _citation_for(location, document, float(value)),
            }
        if not ok or set(items) != set(TEMPLATE_KEYS):
            continue
        return [items[key] for key in TEMPLATE_KEYS]
    return None


def build_content(deal: dict, items: list[dict], facts: dict, source: str) -> dict:
    citation_rows = [
        dict(item["citation"], line_item_key=item["line_item_key"]) for item in items if item.get("citation")
    ]
    unsupported = [item["line_item_key"] for item in items if item.get("value") is None]
    supported = len(items) - len(unsupported)
    uncited = len([item for item in items if item.get("value") is not None and not item.get("citation")])
    summary = (
        f"Standard spread template filled for {deal['deal_reference']} from "
        f"{len(facts['document_rows'])} document(s): {supported} of {len(items)} template lines are supported by a "
        f"cited document location and {len(unsupported)} read '{NOT_SUPPORTED}'."
    )
    # citation-tracker owns the says-who envelope; the structured per-figure
    # citations below are what actually reaches the deal of record.
    envelope = citation_envelope.attach(
        summary, [{"doc_id": row["source_reference"], "text": row["excerpt"]} for row in citation_rows]
    )
    return {
        "template_version": SPREAD_TEMPLATE_VERSION,
        "source": source,
        "spread_line_items": items,
        "citations": citation_rows,
        "unsupported_line_keys": unsupported,
        "supported_line_count": supported,
        "uncited_figure_count": uncited,
        "documents_considered": [d["id"] for d in facts["document_rows"]],
        "document_location_count": len(facts["locations"]),
        "summary": summary,
        # `rationale` is the field the human-gate payload summarises on.
        "rationale": summary,
        "evidence": envelope,
    }


# --------------------------------------------------------------------------
# Drafting — agent output parked as PENDING behind the human gate
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
            "template_version": SPREAD_TEMPLATE_VERSION,
            "supported_line_count": content.get("supported_line_count"),
        },
    )
    return draft


def _content_for(deal: dict, reply: str, facts: dict) -> dict:
    proposal = parse_spread_reply(reply, facts)
    source = "agent"
    if proposal is None:
        proposal = derive_spread(facts)
        source = "deterministic-fallback"
    return build_content(deal, proposal, facts, source)


def adopt_workflow_spread(deal: dict, actor_user_id: str) -> dict | None:
    """Adopt the `spread_financials` node's OWN output as the pending draft.

    The approved process runs the spreading agent inside the run as soon as the
    triage draft is accepted. Re-prompting here would double the spend and mean
    the draft a human reviews is not the output the process produced, so the
    node's reply is adopted and recorded as the agent run (REQ-038).

    Adopted exactly once. A re-draft asked for after a rejection must be a new
    agent call informed by the reviewer's reason — replaying the stored reply
    would hand back the very draft they rejected and book a second agent run
    for a call that never happened.
    """
    run_id = deal.get("workflow_run_id")
    if not run_id or uw.drafts_for(deal["id"], "spread"):
        return None
    try:
        state = workflow_engine.state(run_id)
    except Exception:
        return None
    reply = ((state.get("context") or {}).get("spread_financials") or {}).get("reply")
    if not reply:
        return None
    facts = spread_facts(deal)
    model = uw.model_id()
    tokens_in, tokens_out = uw.estimate_tokens(build_prompt(deal, facts)), uw.estimate_tokens(reply)
    cost_row = costmeter.record(model, tokens_in, tokens_out)
    run = store.insert(
        "agent_runs",
        {
            "tokens_in_estimated": tokens_in,
            "tokens_out_estimated": tokens_out,
            "deal_id": deal["id"],
            "deal_reference": deal["deal_reference"],
            "agent_type": "financial_spreading",
            "agent_name": SPREAD_AGENT_NAME,
            "run_stage": SPREAD_WORKING_STAGE,
            "model_id": model,
            "prompt_template_version": uw.prompt_version(SPREAD_PROMPT_NAME),
            "inputs": run_inputs(deal, facts) | {"workflow_run_id": run_id, "workflow_node": "spread_financials"},
            "raw_output": pii.redact(reply)[:4000],
            # wall clock of the engine tick this node ran inside (the tick the
            # triage acceptance released); the engine exposes no per-node
            # timing, so the number is an upper bound and says so wherever it
            # is shown rather than posing as a measured call duration.
            "latency_ms": uw.last_tick_ms(run_id),
            "latency_basis": "workflow tick wall clock (upper bound — the tick also ran the deterministic nodes)",
            "token_cost": cost_row["usd"],
            "ran_at": uw.now_iso(),
            "error": None,
        },
    )
    uw.log_event(
        "agent.run",
        agent="financial_spreading",
        deal_reference=deal["deal_reference"],
        agent_run_id=run["id"],
        source="workflow",
    )
    return _park_spread_draft(deal, _content_for(deal, reply, facts), run["id"], actor_user_id)


def rejection_feedback(deal: dict) -> str:
    """The reviewer's written reason for rejecting the last spread draft.

    A re-draft that cannot see why the last one was rejected is a loop, not a
    review; the reason the human had to write is fed back into the prompt.
    """
    for row in reversed(uw.drafts_for(deal["id"], "spread")):
        if row.get("review_status") == "rejected":
            reason = str(row.get("review_reason") or "").strip()
            return (
                "\n\nThe previous spread draft was rejected by "
                f"{row.get('reviewed_by_user_id')} for this reason: \"{reason[:500]}\". "
                "Address it using only the document locations listed above; if the record still does not support a "
                f"line, keep \"{NOT_SUPPORTED}\" rather than estimating."
            )
    return ""


def build_spread_draft(deal: dict, actor_user_id: str) -> dict:
    """Run the spreading agent directly and park the result as PENDING.

    Used when there is no unconsumed workflow output to adopt — a re-draft
    after a rejection, say. Nothing here advances a stage on its own.
    """
    facts = spread_facts(deal)
    outcome = uw.run_agent(
        agent_name=SPREAD_AGENT_NAME,
        prompt=build_prompt(deal, facts) + rejection_feedback(deal),
        deal=deal,
        agent_type="financial_spreading",
        run_stage=SPREAD_WORKING_STAGE,
        prompt_name=SPREAD_PROMPT_NAME,
        inputs=run_inputs(deal, facts),
    )
    return _park_spread_draft(deal, _content_for(deal, outcome["reply"], facts), outcome["run"]["id"], actor_user_id)


def start_spread(deal: dict, actor: dict) -> dict:
    """The Draft Review workspace's 'run the spreading agent' action."""
    if deal.get("current_stage") not in SPREAD_FROM_STAGES:
        raise uw.DomainError(
            409,
            f"deal {deal['deal_reference']} is at '{deal.get('current_stage')}'; the financial spread is drafted "
            f"once the intake triage draft has been accepted (stages: {list(SPREAD_FROM_STAGES)})",
        )
    existing = uw.pending_draft(deal["id"], "spread")
    created = False
    if existing is None:
        # The working stage is recorded against the named human who asked for
        # the run — an agent never moves a deal (REQ-014).
        if deal.get("current_stage") == "document_extraction":
            uw.record_transition(
                deal,
                SPREAD_WORKING_STAGE,
                actor["username"],
                reason="financial spreading started by a named analyst",
            )
        existing = adopt_workflow_spread(deal, actor["username"]) or build_spread_draft(deal, actor["username"])
        created = True
    return {"draft": existing, "created": created}


# --------------------------------------------------------------------------
# Human acceptance -> deal-of-record spread line items and their citations
# --------------------------------------------------------------------------


def spread_of_record(deal_id) -> dict:
    line_items = [row for row in store.list("spread_line_items") if row.get("deal_id") == deal_id]
    ids = {row["id"] for row in line_items}
    citation_rows = [
        row for row in store.list("citations") if row.get("deal_id") == deal_id and row.get("spread_line_item_id") in ids
    ]
    return {"spread_line_items": line_items, "citations": citation_rows}


def promote_spread(deal: dict, content: dict, actor: dict) -> dict:
    """Human acceptance is the act that turns the draft into deal-of-record
    data. Idempotent: a replayed acceptance (or the workflow's persist node
    running afterwards) names the rows already on file rather than doubling
    them."""
    already = spread_of_record(deal["id"])
    if already["spread_line_items"]:
        return {
            "spread_line_item_ids": [row["id"] for row in already["spread_line_items"]],
            "citation_ids": [row["id"] for row in already["citations"]],
            "already_persisted": True,
            "template_version": SPREAD_TEMPLATE_VERSION,
        }

    items = content.get("spread_line_items") or []
    # Validate the whole draft BEFORE the first write (FSI hardening rule 1):
    # a half-written spread with an uncited figure in it is worse than none.
    for item in items:
        if item.get("line_item_key") not in TEMPLATE_BY_KEY:
            raise uw.DomainError(422, f"spread line '{item.get('line_item_key')}' is not on the standard template")
        if item.get("value") is not None and not item.get("citation"):
            raise uw.DomainError(
                422,
                f"spread line '{item['line_item_key']}' carries a figure with no citation; an uncited figure "
                "may not become deal-of-record data",
            )

    line_item_ids: list = []
    citation_ids: list = []
    for item in items:
        row = store.insert(
            "spread_line_items",
            {
                "deal_id": deal["id"],
                "deal_reference": deal["deal_reference"],
                "line_item_key": item["line_item_key"],
                "category": item.get("category"),
                "label": item.get("label"),
                "value": item.get("value"),
                "unit": item.get("unit") or "USD",
                "period": item.get("period"),
                "evidence_status": item.get("evidence_status"),
                "note": item.get("note"),
                "template_version": SPREAD_TEMPLATE_VERSION,
                "accepted_by_user_id": actor["username"],
                "accepted_at": uw.now_iso(),
            },
        )
        line_item_ids.append(row["id"])
        citation = item.get("citation")
        if item.get("value") is None or not citation:
            continue
        source_type = citation.get("source_type") or "document_location"
        source_reference = citation.get("source_reference") or ""
        if source_type == "human_correction":
            source_reference = f"human correction recorded at draft review by {actor['username']}"
        citation_ids.append(
            store.insert(
                "citations",
                {
                    "deal_id": deal["id"],
                    "deal_reference": deal["deal_reference"],
                    "cited_value": citation.get("cited_value") or format_value(item.get("value")),
                    "source_type": source_type,
                    "source_reference": source_reference,
                    "document_id": citation.get("document_id"),
                    "document_location_id": citation.get("document_location_id"),
                    "spread_line_item_id": row["id"],
                    "ratio_id": None,
                    "policy_rule_id": None,
                    "created_at": uw.now_iso(),
                },
            )["id"]
        )

    audit = uw.audit_event(
        event_type="spread.persisted",
        action=f"{len(line_item_ids)} spread line item(s) promoted to deal of record with {len(citation_ids)} citation(s)",
        actor_user_id=actor["username"],
        deal_id=deal["id"],
        deal_reference=deal["deal_reference"],
        entity_type="spread_line_items",
        entity_id=line_item_ids[0] if line_item_ids else None,
        new_values={
            "spread_line_item_ids": line_item_ids,
            "citation_ids": citation_ids,
            "template_version": SPREAD_TEMPLATE_VERSION,
            "unsupported_line_keys": content.get("unsupported_line_keys", []),
        },
    )
    uw.log_event(
        "spread.persisted",
        deal_reference=deal["deal_reference"],
        spread_line_items=len(line_item_ids),
        citations=len(citation_ids),
    )
    return {
        "spread_line_item_ids": line_item_ids,
        "citation_ids": citation_ids,
        "template_version": SPREAD_TEMPLATE_VERSION,
        "audit_log_id": audit["id"],
        "already_persisted": False,
    }


def edit_spread(content: dict, edits: dict) -> dict:
    """A reviewer correcting a figure before accepting it.

    The corrected number is the human's, so its provenance becomes the human —
    it never keeps a document citation that does not state it.
    """
    raw = edits.get("line_items") if isinstance(edits.get("line_items"), dict) else edits.get("values")
    if not isinstance(raw, dict) or not raw:
        raise uw.DomainError(400, "an edited spread must supply line_items: {\"<template key>\": <number>}")
    items = {item["line_item_key"]: item for item in content.get("spread_line_items") or []}
    # Validate every correction BEFORE applying any of them, so a batch with
    # one bad line cannot leave half a human edit on the draft.
    corrections: dict = {}
    for key, value in raw.items():
        if key not in TEMPLATE_BY_KEY or key not in items:
            raise uw.DomainError(400, f"'{key}' is not a line on the standard spread template")
        if value is None:
            corrections[key] = None
        elif isinstance(value, bool) or not isinstance(value, (int, float)):
            raise uw.DomainError(400, f"spread line '{key}' must be corrected to a number (or null)")
        elif abs(float(value)) > MAX_LINE_VALUE:
            raise uw.DomainError(400, f"spread line '{key}' is out of range")
        else:
            corrections[key] = float(value)

    applied: dict = {}
    for key, new_value in corrections.items():
        item = items[key]
        applied[key] = {"from": item.get("value"), "to": new_value}
        previous = item.get("citation") or {}
        item["value"] = new_value
        item["value_display"] = format_value(new_value)
        if new_value is None:
            item["evidence_status"] = "not_supported"
            item["note"] = NOT_SUPPORTED
            item["citation"] = None
        else:
            item["evidence_status"] = "human_corrected"
            item["note"] = "corrected by the reviewing human at the draft-review gate"
            item["citation"] = {
                "source_type": "human_correction",
                "document_id": None,
                "document_location_id": None,
                "document_name": "human correction",
                "document_type": None,
                "page_number": None,
                "section": "draft review",
                "excerpt": f"agent figure {previous.get('cited_value', NOT_SUPPORTED)} corrected at review",
                "source_reference": "human correction recorded at draft review",
                "cited_value": format_value(new_value),
            }
    # Keep the derived counters honest after an edit.
    items_list = content.get("spread_line_items") or []
    content["citations"] = [
        dict(item["citation"], line_item_key=item["line_item_key"]) for item in items_list if item.get("citation")
    ]
    content["unsupported_line_keys"] = [item["line_item_key"] for item in items_list if item.get("value") is None]
    content["supported_line_count"] = len(items_list) - len(content["unsupported_line_keys"])
    content["uncited_figure_count"] = len(
        [item for item in items_list if item.get("value") is not None and not item.get("citation")]
    )
    return applied


# --------------------------------------------------------------------------
# Workflow handler — deal-underwriting/persist_spread
# --------------------------------------------------------------------------


def accepted_spread_draft(deal_id) -> dict | None:
    for row in reversed(uw.drafts_for(deal_id, "spread")):
        if row.get("review_status") in ("accepted", "edited"):
            return row
    return None


def handler_persist_spread_line_items(context: dict) -> dict:
    deal = uw.workflow_deal(context)
    draft = accepted_spread_draft(deal["id"])
    if draft is None:
        raise workflow_engine.WorkflowError("the financial spread has not been accepted by a named human")
    reviewer = draft.get("reviewed_by_user_id") or deal["submitted_by_user_id"]
    result = promote_spread(deal, draft["draft_content"], {"username": reviewer})
    audit_log_id = result.get("audit_log_id")
    if audit_log_id is None:
        audit_log_id = uw.audit_event(
            event_type="spread.persist_confirmed",
            action="spread line items already on file for this deal; nothing re-written",
            actor_user_id=reviewer,
            deal_id=deal["id"],
            deal_reference=deal["deal_reference"],
            entity_type="spread_line_items",
            new_values={"spread_line_item_ids": result["spread_line_item_ids"]},
        )["id"]
    return {
        "deal_id": deal["deal_reference"],
        "spread_line_item_ids": result["spread_line_item_ids"],
        "citation_ids": result["citation_ids"],
        "reviewed_by_user_id": reviewer,
        "audit_log_id": audit_log_id,
    }


workflow_engine.register_handler("persist_spread_line_items", handler_persist_spread_line_items)

uw.register_draft_type(
    "spread",
    promoter=promote_spread,
    editor=edit_spread,
    advances=(SPREAD_FROM_STAGES, SPREAD_TO_STAGE),
    # Correcting a figure moves it off the document that cites it, so the
    # record has to carry the reviewer's written justification for it.
    edit_requires_reason=True,
)
