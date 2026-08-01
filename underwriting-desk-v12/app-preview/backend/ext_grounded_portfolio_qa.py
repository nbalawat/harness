"""ext_grounded_portfolio_qa: slice `grounded-portfolio-qa`.

A credit officer asks the portfolio desk a question in plain English. Retrieval
is scoped to the asker's RBAC role server-side (R-053/R-054) before the
Portfolio Q&A Agent ever sees a record; every statement returned is tied to
the deal ids actually retrieved (R-015); the whole exchange — question,
answer, sources, and trace — is written to the immutable
`portfolio_qa_sessions` table for audit (R-029/R-056).

GROUNDING: the agent's knowledge is assembled at question time from the STORED
deal records — pipeline stage, status, requested/exposure amounts, risk grade,
whether a spread has been accepted, open policy exceptions, key ratios and
ownership — for exactly the deals the asking user's role may see. That record
set is handed to `agent_runtime.respond()` as the provided knowledge for the
question, so portfolio questions ("which deals await tiered approval", "what is
sitting in intake") are answered with real deal codes and real figures instead
of being refused as uncovered.

Three properties are guaranteed deterministically, in code — never by trusting
the model:

  * IDENTITY IS FAIL-CLOSED AND UNCONDITIONAL. Every route here resolves the
    caller before it touches a record: `/api/qa/ask` and `/api/qa/book-summary`
    through `identity.require_actor` (no identity → 401, unknown/deactivated →
    403, wrong role → 403) and `/api/qa/sessions` through
    `identity.require_reader` (an unidentified caller reads the *redacted*
    session log — row shape and timing only, never a question, an answer or a
    deal id). No guard on this module sits behind an `if acting_user_email:`;
    scope is ALWAYS resolved through `identity.visible_deals`. On top of that
    the roster's read tools are themselves scope-guarded (`permitted_scope` /
    `_in_scope`), so a read of a deal outside the resolved scope raises even if
    a future caller reaches the tools directly.

  * NO FIGURE IS EVER PRODUCED BY THE MODEL. Every number the desk quotes is
    computed here (`_portfolio_facts`), and the model's narrative is only
    allowed through when `_verify_narrative` confirms it cites the retrieved
    records AND that every numeral in it is one this module computed.
    Otherwise the answer IS the deterministic, records-derived digest
    (`_deterministic_digest`); the raw model text is kept in the session trace
    for audit but is never served as the answer.

  * WHEN THE RECORDS DO NOT CONTAIN AN ANSWER THE DESK SAYS SO. An asker with
    nothing in scope is told there is nothing to ground an answer in and is
    given no figures at all; a "none match" answer still cites the deals that
    were actually read to reach it (the citable-ids honesty guard).

The `portfolio-qa` workflow's (workflows/workflows.json) four deterministic
nodes are implemented and registered here as real handlers
(resolve_qa_permission_scope for `scope`, retrieve_grounded_deal_context for
`retrieve`, verify_answer_grounding for `groundcheck`, record_qa_session for
`record`), following the precedent set by ext_deal_intake.py: they are called
directly from the REST endpoint below rather than driven through
workflow_engine.start()/tick(), because the generic engine's agent-node
wrapper only ever produces {"reply": ...} and cannot satisfy this workflow's
richer `answer` output_schema (answer / cited_record_refs /
unsupported_claims). The `accept` human node is folded into the same call —
the asking officer accepting the drafted answer is what triggers recording,
mirroring triage/spread acceptance elsewhere in this app, just without a
second round trip since a Q&A answer never changes deal state.
"""
import contextlib
import contextvars
import datetime
import json
import os
import re

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import agent_runtime
import citations
import deals_repo
import identity
import tools
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

PORTFOLIO_AGENT_NAME = "Portfolio Q&A Agent"
# Server-side authority to use the desk at all; scope within it is resolved
# per-role below. identity.require_actor is FAIL-CLOSED, so a caller with no
# identity is a 401 and an unrecognised one reads nothing.
QA_PERMISSION = "portfolio.query"
# The permission that widens read scope from "my own deals" to the whole book.
BOOK_WIDE_PERMISSION = "deal.view_all"

# An unbounded question is a denial-of-service and a prompt-injection surface,
# so it is length-bounded at the edge (same standard as main.ChatRequest).
MIN_QUESTION_CHARS = 1
MAX_QUESTION_CHARS = 2000

# Every answer this desk produces is a draft for a human, never a decision.
DRAFT_FRAMING = "Automated draft pending analyst approval."

# What an unidentified caller sees in place of a recorded session's content.
REDACTED = "[redacted — identify yourself to read the Q&A session log]"

# A request to act on a deal is refused before it ever reaches retrieval or
# the model — the read-only Q&A agent holds no write tools at all (R-055),
# and the roster's eval_criteria require an explicit refusal here.
DECISION_KEYWORDS = (
    "approve this deal", "approve the deal", "decline this deal", "decline the deal",
    "move this deal forward", "move forward", "advance this deal", "advance the deal",
    "route this to", "waive the", "waive this", "resolve the exception",
)
IDENTITY_PATTERNS = (
    re.compile(r"who\s+(are\s+you|am\s+i\s+talking\s+to)", re.I),
    re.compile(r"what\s+are\s+you\b", re.I),
)

# The eight ordered pipeline stages (same vocabulary as the board) and the
# plain-English phrases a credit officer actually uses for them. Question
# routing is deterministic: the model never picks which records it gets.
PIPELINE_STAGES = (
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "tiered_approval",
    "closing",
)
STAGE_PHRASES = {
    "tiered_approval": (
        "tiered approval", "await approval", "awaiting approval", "awaits approval",
        "pending approval", "approval queue", "up for approval", "need approval",
        "needs approval", "for approval", "in approval", "approval tier",
        "sitting with the officer",
    ),
    "policy_compliance": ("policy compliance", "compliance review", "compliance check"),
    "memo_drafting": ("memo drafting", "memo stage", "drafting the memo", "credit memo stage"),
    "risk_grading": ("risk grading", "grading stage", "being graded"),
    "financial_spreading": ("financial spreading", "spreading stage", "being spread"),
    "document_extraction": ("document extraction", "document collection", "collecting documents"),
    "intake": ("in intake", "at intake", "intake stage", "just filed", "newly filed", "newly submitted"),
    "closing": ("closing", "closed", "booked"),
}
LACK_WORDS = ("lack", "missing", "without", "no accepted", "not accepted", "unaccepted", "yet to", "still need")
# The catch-all subject: the question is about the book as a whole.
WHOLE_BOOK = "every deal in your scope"
STAGE_LABELS = {s: s.replace("_", " ") for s in PIPELINE_STAGES}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _load_roster():
    path = os.path.join(os.path.dirname(__file__), "..", "agents", "roster.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _agent():
    for a in _load_roster()["agents"]:
        if a["name"] == PORTFOLIO_AGENT_NAME:
            return a
    raise RuntimeError("Portfolio Q&A Agent missing from roster")


def _money(amount):
    try:
        return "${:,.0f}".format(float(amount or 0))
    except (TypeError, ValueError):
        return "$0"


# ------------------------------------------------------------------------
# read scope: the roster's declared read tools are themselves fail-closed.
#
# A permission scope resolved by `resolve_qa_permission_scope` is bound for the
# duration of a retrieval; every read tool asserts the deal it is asked for is
# inside it. So the scope check is not something a caller can forget to make —
# reading OUTSIDE a resolved scope, or with no scope bound at all, raises.
# ------------------------------------------------------------------------

_READ_SCOPE = contextvars.ContextVar("qa_read_scope", default=None)


@contextlib.contextmanager
def permitted_scope(deal_ids):
    """Bind the deal ids the current caller is permitted to read."""
    token = _READ_SCOPE.set(frozenset(deal_ids or ()))
    try:
        yield
    finally:
        _READ_SCOPE.reset(token)


def _in_scope(deal_id):
    allowed = _READ_SCOPE.get()
    if allowed is None:
        raise HTTPException(
            status_code=403,
            detail="portfolio read tools may only be used inside a resolved permission scope",
        )
    if deal_id not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"deal '{deal_id}' is outside this caller's permission scope",
        )
    return deal_id


# ------------------------------------------------------------------------
# tool-registry: the roster's declared read tools, enforced through
# tools.invoke() so the agent's allow/deny list is a structural guarantee
# rather than just documentation (R-055).
# ------------------------------------------------------------------------

def _read_deal(deal_id):
    return deals_repo.get_deal(_in_scope(deal_id))


def _read_spread(deal_id):
    _in_scope(deal_id)
    return [r for r in store.list("financial_spread_template") if r.get("deal_id") == deal_id]


def _read_ratios(deal_id):
    _in_scope(deal_id)
    return [r for r in store.list("financial_ratios") if r.get("deal_id") == deal_id]


def _read_risk_grade(deal_id):
    _in_scope(deal_id)
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_id]
    return rows[-1] if rows else None


def _read_memo(deal_id):
    _in_scope(deal_id)
    rows = [o for o in store.list("agent_outputs") if o.get("deal_id") == deal_id and o.get("agent_id") == "credit-memo"]
    return rows[-1] if rows else None


def _read_policy_exceptions(deal_id):
    _in_scope(deal_id)
    return [r for r in store.list("policy_exceptions") if r.get("deal_id") == deal_id]


def _read_audit_timeline(deal_id):
    _in_scope(deal_id)
    return [r for r in store.list("audit_log") if r.get("deal_id") == deal_id]


def _search_deals_in_scope(visible_deal_ids, keyword=None):
    """Search is bounded by the intersection of the caller's stated visibility
    and the scope actually bound for this read — never by the argument alone."""
    bound = _READ_SCOPE.get()
    if bound is None:
        raise HTTPException(
            status_code=403,
            detail="portfolio read tools may only be used inside a resolved permission scope",
        )
    visible = set(visible_deal_ids or ()) & set(bound)
    found = [d for d in deals_repo.all_current_deals() if d.get("deal_code") in visible]
    if keyword:
        k = keyword.lower()
        found = [d for d in found if k in (d.get("borrower_name") or "").lower() or k in (d.get("borrower_industry") or "").lower()]
    return found


for _name, _fn in {
    "search_deals_in_scope": _search_deals_in_scope,
    "read_deal": _read_deal,
    "read_spread": _read_spread,
    "read_ratios": _read_ratios,
    "read_risk_grade": _read_risk_grade,
    "read_memo": _read_memo,
    "read_policy_exceptions": _read_policy_exceptions,
    "read_audit_timeline": _read_audit_timeline,
}.items():
    tools.register(_name, _fn)


# ------------------------------------------------------------------------
# workflow-engine handlers (portfolio-qa: scope, retrieve, groundcheck, record)
# ------------------------------------------------------------------------

def resolve_qa_permission_scope(context):
    """Node `scope`: R-053/R-054 — retrieval scope is resolved from server-
    side RBAC before the agent sees anything; the agent never computes its
    own scope. A relationship manager only ever sees deals they created or
    hold (R-053); analysts, officers, and admins hold `deal.view_all` and so
    see the whole active book, which is what R-014's "spanning active deals"
    portfolio question requires.

    UNCONDITIONALLY guarded with identity.require_actor — no identity is a
    401, an unknown or deactivated one a 403 — and scoping always runs through
    `identity.visible_deals`, the app's single read-scoping helper, rather than
    a role list this module keeps for itself. Safe when reached through
    workflow_engine.start() as well as through the endpoint."""
    inputs = context.get("inputs", context)
    user = identity.require_actor(
        inputs.get("acting_user_email"), QA_PERMISSION, "ask the portfolio desk"
    )
    visible = [
        d["deal_code"]
        for d in identity.visible_deals(user, deals_repo.all_current_deals())
        if d.get("deal_code")
    ]
    return {
        "user_id": user["id"],
        "role": user.get("role"),
        "question": inputs.get("question"),
        "visible_deal_ids": sorted(visible),
        "scope_is_empty": len(visible) == 0,
    }


workflow_engine.register_handler("resolve_qa_permission_scope", resolve_qa_permission_scope)


def _user_email(user_id):
    for u in store.list("users"):
        if u.get("id") == user_id:
            return u.get("email")
    return None


def _days_since(timestamp):
    if not timestamp:
        return None
    try:
        then = datetime.datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=datetime.timezone.utc)
    return max(0, (datetime.datetime.now(datetime.timezone.utc) - then).days)


def _build_record(agent, deal_code):
    """The live knowledge row for one deal, read only through the roster's
    declared read tools — which refuse a deal outside the bound scope."""
    deal = tools.invoke(agent, "read_deal", deal_id=deal_code)
    if deal is None:
        return None
    spread_rows = tools.invoke(agent, "read_spread", deal_id=deal_code)
    grade = tools.invoke(agent, "read_risk_grade", deal_id=deal_code)
    exceptions = tools.invoke(agent, "read_policy_exceptions", deal_id=deal_code)
    ratios = tools.invoke(agent, "read_ratios", deal_id=deal_code)
    open_exceptions = [e for e in exceptions if e.get("status") == "open"]
    return {
        "deal_id": deal_code,
        "borrower_name": deal.get("borrower_name"),
        "borrower_industry": deal.get("borrower_industry"),
        "current_stage": deal.get("current_stage"),
        "current_status": deal.get("current_status"),
        "requested_amount": deal.get("requested_amount"),
        "exposure_amount": deal.get("exposure_amount"),
        "risk_grade": (grade or {}).get("grade") if grade else deal.get("risk_grade"),
        "has_accepted_spread": bool(spread_rows),
        "spread_line_count": len(spread_rows),
        "open_policy_exceptions": len(open_exceptions),
        "open_exception_rules": [e.get("rule_reference") for e in open_exceptions][:5],
        "key_ratios": {r.get("ratio_type"): r.get("result") for r in ratios},
        "owner_email": _user_email(deal.get("assigned_to_user_id")),
        "filed_at": deal.get("created_at"),
        "days_since_activity": _days_since(deal.get("last_activity_timestamp") or deal.get("updated_at")),
    }


def _records_for(scope_deal_ids):
    """Build the knowledge rows for a resolved scope, with that scope bound so
    the read tools can enforce it."""
    agent = _agent()
    with permitted_scope(scope_deal_ids):
        return [rec for rec in (_build_record(agent, code) for code in scope_deal_ids) if rec is not None]


def _portfolio_facts(records):
    """Every figure the desk ever quotes is computed HERE, in deterministic
    code — no financial arithmetic is ever delegated to the model (R-042)."""
    by_stage = {}
    for r in records:
        stage = r.get("current_stage") or "intake"
        by_stage[stage] = by_stage.get(stage, 0) + 1
    total_exposure = sum(
        float(r.get("exposure_amount") or r.get("requested_amount") or 0) for r in records
    )
    return {
        "deal_count": len(records),
        "total_exposure": total_exposure,
        "total_exposure_display": _money(total_exposure),
        "by_stage": {s: by_stage[s] for s in PIPELINE_STAGES if s in by_stage},
        "open_exception_count": sum(int(r.get("open_policy_exceptions") or 0) for r in records),
        "without_accepted_spread": len([r for r in records if not r.get("has_accepted_spread")]),
    }


def _select_records(question, records):
    """Deterministic question routing over the already-scoped record set:
    which of the caller's visible deals bear on this question. Only ever
    narrows the scoped set — never widens it — so R-054's cap always holds.
    Returns (selected_records, subject_phrase)."""
    q = (question or "").lower()

    if "spread" in q and any(w in q for w in LACK_WORDS):
        return [r for r in records if not r["has_accepted_spread"]], "deals with no accepted financial spread"

    if "exception" in q or "breach" in q or "policy" in q:
        return [r for r in records if r["open_policy_exceptions"]], "deals carrying an open policy exception"

    for stage, phrases in STAGE_PHRASES.items():
        if any(p in q for p in phrases):
            return (
                [r for r in records if r["current_stage"] == stage],
                f"deals at the {STAGE_LABELS[stage]} stage",
            )

    named = [r for r in records if r["borrower_name"] and r["borrower_name"].lower() in q]
    if named:
        return named, "the deals you named"

    if any(w in q for w in ("grade", "rating", "riskiest")):
        graded = [r for r in records if r["risk_grade"] not in (None, "")]
        if graded:
            return graded, "deals that carry a risk grade"

    return list(records), WHOLE_BOOK


def retrieve_grounded_deal_context(context):
    """Node `retrieve`: R-015 grounds answers in stored deal data, capped at
    the scope resolved above — record selection stays in code the agent
    cannot widen (R-054). The returned `context_records` ARE the agent's
    knowledge for this question.

    There is deliberately NO top-k here: every record in the caller's scope
    that bears on the question is retrieved and cited, however large the book
    grows. The only truncation anywhere in this module is a display one in
    `_deterministic_digest`, applied AFTER relevance filtering, disclosed in
    the prose ("+N more"), and never applied to `source_deal_ids` — so a
    relevant deal is never silently dropped from an answer's sources."""
    visible = context.get("visible_deal_ids", [])
    question = context.get("question")

    scope_records = _records_for(visible)
    selected, subject = _select_records(question, scope_records)

    return {
        "context_records": selected,
        "source_deal_ids": [r["deal_id"] for r in selected],
        "record_count": len(selected),
        "subject": subject,
        "scope_deal_ids": [r["deal_id"] for r in scope_records],
        "scope_records": scope_records,
        "scope_facts": _portfolio_facts(scope_records),
        "selection_facts": _portfolio_facts(selected),
    }


workflow_engine.register_handler("retrieve_grounded_deal_context", retrieve_grounded_deal_context)


# ------------------------------------------------------------------------
# knowledge assembly + deterministic digest
# ------------------------------------------------------------------------

def _record_line(r):
    bits = [
        r["deal_id"],
        r["borrower_name"] or "unnamed borrower",
        f"industry {r['borrower_industry'] or 'unstated'}",
        f"stage {STAGE_LABELS.get(r['current_stage'], r['current_stage'] or 'intake')}",
        f"status {r['current_status'] or 'unset'}",
        f"requested {_money(r['requested_amount'])}",
        f"exposure {_money(r['exposure_amount'])}",
        f"risk grade {r['risk_grade'] if r['risk_grade'] not in (None, '') else 'not yet graded'}",
        "accepted spread: yes" if r["has_accepted_spread"] else "accepted spread: no",
        f"open policy exceptions: {r['open_policy_exceptions']}",
    ]
    if r["key_ratios"]:
        bits.append("ratios " + ", ".join(f"{k} {v}" for k, v in r["key_ratios"].items() if k))
    if r["owner_email"]:
        bits.append(f"owner {r['owner_email']}")
    if r["days_since_activity"] is not None:
        bits.append(f"{r['days_since_activity']}d since last activity")
    return " | ".join(str(b) for b in bits)


def _facts_line(facts):
    stages = ", ".join(f"{STAGE_LABELS.get(s, s)} {n}" for s, n in facts["by_stage"].items()) or "none"
    return (
        f"deals {facts['deal_count']}; total exposure {facts['total_exposure_display']}; "
        f"by stage: {stages}; without an accepted spread {facts['without_accepted_spread']}; "
        f"open policy exceptions {facts['open_exception_count']}"
    )


def _knowledge_block(retrieve):
    lines = [
        "DEAL RECORDS — live rows from this bank's underwriting system of record, read at "
        "question time and already filtered to the deals this user is permitted to see:",
    ]
    for r in retrieve["context_records"]:
        lines.append("- " + _record_line(r))
    if not retrieve["context_records"]:
        lines.append("- (no deal in this user's scope matches the question)")
    lines.append(
        "TOTALS FOR THE MATCHING RECORDS (computed by the system, authoritative — quote them "
        "as given, never recompute): " + _facts_line(retrieve["selection_facts"])
    )
    lines.append(
        "TOTALS FOR THE USER'S WHOLE VISIBLE BOOK: " + _facts_line(retrieve["scope_facts"])
    )
    return "\n".join(lines)


def _deterministic_digest(question, retrieve):
    """The grounded answer written straight from the stored records, in code.
    This — not the model's prose — is what the desk serves whenever the model's
    narrative cannot be verified against the records it was handed, so a
    portfolio question is answered with real deal codes and real figures
    instead of a refusal, and never with a figure nobody computed."""
    selected = retrieve["context_records"]
    subject = retrieve["subject"]
    if not selected:
        scope_ids = retrieve["scope_deal_ids"]
        listed = ", ".join(scope_ids[:8]) + ("…" if len(scope_ids) > 8 else "")
        return (
            f"[{PORTFOLIO_AGENT_NAME}] {DRAFT_FRAMING} None of the {len(scope_ids)} deal(s) you may "
            f"see match {subject}. The book you can see is {listed} — {_facts_line(retrieve['scope_facts'])}. "
            "I have not estimated anything beyond those stored records."
        )
    facts = retrieve["selection_facts"]
    items = []
    for r in selected[:8]:
        grade = r["risk_grade"] if r["risk_grade"] not in (None, "") else "ungraded"
        items.append(
            f"{r['deal_id']} — {r['borrower_name']}, {STAGE_LABELS.get(r['current_stage'], r['current_stage'])}, "
            f"exposure {_money(r['exposure_amount'])}, grade {grade}, "
            f"{'spread accepted' if r['has_accepted_spread'] else 'no accepted spread'}"
            + (f", {r['open_policy_exceptions']} open exception(s)" if r["open_policy_exceptions"] else "")
        )
    more = f" (+{len(selected) - 8} more)" if len(selected) > 8 else ""
    if subject == WHOLE_BOOK:
        head = (
            f"[{PORTFOLIO_AGENT_NAME}] {DRAFT_FRAMING} Across the {facts['deal_count']} deal(s) you can "
            f"see, carrying {facts['total_exposure_display']} of exposure: "
        )
    else:
        head = (
            f"[{PORTFOLIO_AGENT_NAME}] {DRAFT_FRAMING} {facts['deal_count']} deal(s) in your scope match "
            f"{subject}, carrying {facts['total_exposure_display']} of exposure: "
        )
    return (
        head
        + "; ".join(items)
        + more
        + ". Figures are read straight from the stored deal records."
    )


# ------------------------------------------------------------------------
# narrative verification — the model's prose is a CANDIDATE, never the answer
# ------------------------------------------------------------------------

_REFUSAL_MARKERS = (
    "not covered", "does not cover", "doesn't cover", "hand off", "hand this off",
    "handing off", "no information", "cannot answer", "can't answer", "unable to answer",
    "not in my knowledge", "outside my knowledge", "no knowledge", "insufficient information",
    "no data available", "i don't have", "i do not have",
)

_DEAL_CODE_RE = re.compile(r"deal-\d+", re.I)
_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _as_number(token):
    try:
        return round(float(str(token).replace(",", "").replace("$", "").strip()), 4)
    except (TypeError, ValueError):
        return None


def _system_computed_numbers(retrieve):
    """Every numeral this module computed or read from a stored record. A
    narrative may only be served if every number in it is in this set — that is
    what "no financial math is delegated to the model" means mechanically."""
    allowed = set()

    def add(value):
        n = _as_number(value)
        if n is not None:
            allowed.add(n)

    for facts in (retrieve["selection_facts"], retrieve["scope_facts"]):
        add(facts["deal_count"])
        add(facts["total_exposure"])
        add(facts["open_exception_count"])
        add(facts["without_accepted_spread"])
        for count in facts["by_stage"].values():
            add(count)
    for r in retrieve["context_records"] + retrieve.get("scope_records", []):
        for key in (
            "requested_amount", "exposure_amount", "open_policy_exceptions",
            "spread_line_count", "days_since_activity",
        ):
            add(r.get(key))
        for value in (r.get("key_ratios") or {}).values():
            add(value)
    return allowed


def _verify_narrative(narrative, retrieve):
    """Decide whether the model's prose may be served as the answer.

    Returns (ok, reason). FAIL-CLOSED — anything unverifiable falls back to the
    deterministic digest, and the raw text is kept only in the audit trace.
    """
    if not narrative or not narrative.strip():
        return False, "empty_reply"
    low = narrative.lower()
    if "provided knowledge for this question" in low:
        return False, "echoed_the_prompt"
    if any(marker in low for marker in _REFUSAL_MARKERS):
        return False, "refused_despite_records"
    selected = retrieve["context_records"]
    if not selected:
        return False, "no_matching_records"
    if not any(r["deal_id"].lower() in low for r in selected):
        return False, "cited_none_of_the_records"
    # Any deal id it names must be one it was actually given.
    given = {r["deal_id"].lower() for r in selected} | {c.lower() for c in retrieve["scope_deal_ids"]}
    for code in _DEAL_CODE_RE.findall(low):
        if code not in given:
            return False, f"cited_out_of_scope_deal:{code}"
    # Any figure it quotes must be one THIS module computed.
    allowed = _system_computed_numbers(retrieve)
    for token in _NUMBER_RE.findall(_DEAL_CODE_RE.sub(" ", narrative)):
        value = _as_number(token)
        if value is None:
            continue
        if value not in allowed:
            return False, f"quoted_a_figure_the_system_did_not_compute:{token}"
    return True, "agent"


def _summarize(record):
    bits = [record["borrower_name"] or record["deal_id"], "stage " + (record["current_stage"] or "unknown")]
    if record["risk_grade"] not in (None, ""):
        bits.append("grade " + str(record["risk_grade"]))
    bits.append("accepted spread" if record["has_accepted_spread"] else "no accepted spread yet")
    if record["open_policy_exceptions"]:
        bits.append(f"{record['open_policy_exceptions']} open policy exception(s)")
    return ", ".join(bits)


def _build_answer(narrative, records):
    """citation-tracker does the says-who structuring — never hand-rolled."""
    sources = [{"doc_id": r["deal_id"], "text": _summarize(r)} for r in records]
    cited = citations.attach(narrative, sources)
    rendered = citations.render(cited)
    return rendered, [s["doc_id"] for s in sources], cited["grounded"]


def verify_answer_grounding(context):
    """Node `groundcheck`: R-015 makes grounding a hard condition, checked
    mechanically against the retrieved set — never the agent marking its own
    answer as sufficiently sourced."""
    cited = context.get("cited_record_refs", [])
    visible = context.get("visible_deal_ids", [])
    out_of_scope = [c for c in cited if c not in visible]
    unsourced = context.get("unsupported_claims", [])
    return {
        "grounded": bool(cited) and not out_of_scope,
        "cited_deal_ids": cited,
        "out_of_scope_citation_count": len(out_of_scope),
        "unsourced_claim_count": len(unsourced),
    }


workflow_engine.register_handler("verify_answer_grounding", verify_answer_grounding)


def record_qa_session(context):
    """Node `record`: R-029/R-056 — the system writes the accepted answer
    plus its sources and full trace to the immutable session log; the agent
    that drafted the answer never touches this table itself."""
    row = store.insert("portfolio_qa_sessions", {
        "user_id": context["user_id"],
        "question": context["question"],
        "grounded_response": context["answer"],
        "source_deal_ids": context["source_deal_ids"],
        "trace_data": context.get("trace_data") or {},
        "created_at": _now(),
    })
    # The hardened audit module stamps `actor` on every entry — a Q&A session is
    # caused by the person who asked, never by "system".
    actor_email = _user_email(context["user_id"]) or str(context["user_id"])
    entry = audit(
        "qa.session_recorded",
        {
            "actor_user_id": context["user_id"],
            "resource_type": "portfolio_qa_session",
            "resource_id": row["id"],
            "after": {"question": context["question"], "source_deal_ids": context["source_deal_ids"]},
        },
        actor=actor_email,
    )
    return {
        "session_id": row["id"],
        "source_deal_ids": context["source_deal_ids"],
        "trace_data": row["trace_data"],
        "accepted_by_user_id": context.get("accepted_by_user_id", context["user_id"]),
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_qa_session", record_qa_session)


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

class QaAskRequest(BaseModel):
    # Bounded at the edge: an empty or unbounded question is a 422 before it
    # ever reaches identity resolution or the model.
    question: str = Field(min_length=MIN_QUESTION_CHARS, max_length=MAX_QUESTION_CHARS)
    # Optional in the schema so that an anonymous ask is answered by the
    # identity guard with 401 ("identify yourself") rather than by FastAPI with
    # a 422 that says nothing about authority.
    acting_user_email: str | None = None


@router.post("/api/qa/ask")
def ask_portfolio_qa(req: QaAskRequest):
    # FAIL-CLOSED authority check before any record is read: no identity → 401,
    # unknown/deactivated → 403, role without portfolio.query → 403.
    identity.require_actor(req.acting_user_email, QA_PERMISSION, "ask the portfolio desk")

    scope = resolve_qa_permission_scope({"inputs": {"acting_user_email": req.acting_user_email, "question": req.question}})
    question = req.question or ""

    # Identity questions are about the agent, not a deal claim — answered
    # directly, skipping retrieval and grounding entirely.
    if any(p.search(question) for p in IDENTITY_PATTERNS):
        narrative = agent_runtime.respond(
            f"A user asked: '{question}'. Identify yourself by name and role in one sentence.",
            agent_name=PORTFOLIO_AGENT_NAME,
        )
        if PORTFOLIO_AGENT_NAME not in narrative:
            narrative = f"[{PORTFOLIO_AGENT_NAME}] {narrative}"
        rec = record_qa_session({
            "user_id": scope["user_id"], "question": question, "answer": narrative,
            "source_deal_ids": [], "trace_data": {"scope": scope, "kind": "identity"},
        })
        return {
            "question": question, "answer": narrative, "source_deal_ids": [], "cited_record_refs": [],
            "grounded": True, "session_id": rec["session_id"], "user_id": scope["user_id"], "role": scope["role"],
        }

    if any(k in question.lower() for k in DECISION_KEYWORDS):
        refusal = (
            f"[{PORTFOLIO_AGENT_NAME}] I only provide information about deals — I cannot approve, "
            "decline, waive, or advance one. That decision belongs to an authorised human on the "
            "deal's approval screen."
        )
        rec = record_qa_session({
            "user_id": scope["user_id"], "question": question, "answer": refusal,
            "source_deal_ids": [], "trace_data": {"scope": scope, "kind": "refused_decision_request"},
        })
        return {
            "question": question, "answer": refusal, "source_deal_ids": [], "cited_record_refs": [],
            "grounded": True, "refused": True, "session_id": rec["session_id"],
            "user_id": scope["user_id"], "role": scope["role"],
        }

    # Genuinely no data: say so, cite nothing, invent nothing.
    if scope["scope_is_empty"]:
        answer = (
            f"[{PORTFOLIO_AGENT_NAME}] {DRAFT_FRAMING} You have no deals in scope to answer from, "
            "so there is nothing stored for me to ground an answer in."
        )
        rec = record_qa_session({
            "user_id": scope["user_id"], "question": question, "answer": answer,
            "source_deal_ids": [], "trace_data": {"scope": scope},
        })
        return {
            "question": question, "answer": answer, "source_deal_ids": [], "cited_record_refs": [],
            "grounded": False, "session_id": rec["session_id"], "user_id": scope["user_id"], "role": scope["role"],
        }

    retrieve = retrieve_grounded_deal_context({"visible_deal_ids": scope["visible_deal_ids"], "question": question})

    # The retrieved records ARE the knowledge for this question — handed to
    # the agent explicitly so it answers from live deal data rather than
    # declaring the question uncovered.
    prompt = (
        "PROVIDED KNOWLEDGE for this question — you are grounded in these records; they are "
        "current, authoritative, and already permission-scoped to the person asking.\n"
        + _knowledge_block(retrieve)
        + f"\n\nQUESTION from a {scope['role'] or 'credit'} user: \"{question}\"\n\n"
        "Answer using ONLY the records and totals above — never model recall or outside knowledge. "
        "Name the deal id (e.g. DEAL-1001) behind every statement and quote the stored figures "
        "exactly as given; do not recompute or estimate any number. If the records above genuinely "
        "do not contain what was asked, say plainly what is missing rather than inventing it. "
        "You are read-only: you may not approve, decline, or advance any deal."
    )
    raw_narrative = agent_runtime.respond(prompt, agent_name=PORTFOLIO_AGENT_NAME)

    # The model's prose is only a candidate. It is served ONLY when it is
    # verifiably grounded in the retrieved records and quotes no figure this
    # module did not compute; otherwise the answer is the records-derived
    # digest and the raw reply survives only in the audit trace.
    narrative_ok, narrative_verdict = _verify_narrative(raw_narrative, retrieve)
    narrative = raw_narrative if narrative_ok else _deterministic_digest(question, retrieve)
    narrative_source = "agent" if narrative_ok else "deterministic_records_digest"

    # Deals were examined even when none matched — the "none match" claim is
    # itself grounded in those records, so they are cited (the citable-ids
    # honesty guard: an answer never claims a source it did not read, and never
    # hides the reading it did do).
    citable = retrieve["context_records"] or retrieve["scope_records"]
    answer_text, cited_ids, _sourced = _build_answer(narrative, citable)
    unsupported = [] if retrieve["context_records"] else [f"no deal in scope matches {retrieve['subject']}"]

    ground = verify_answer_grounding({
        "cited_record_refs": cited_ids,
        "visible_deal_ids": scope["visible_deal_ids"],
        "unsupported_claims": unsupported,
    })

    rec = record_qa_session({
        "user_id": scope["user_id"],
        "question": question,
        "answer": answer_text,
        "source_deal_ids": cited_ids,
        "trace_data": {
            "scope": scope,
            "retrieve": {k: v for k, v in retrieve.items() if k != "scope_records"},
            "groundcheck": ground,
            "narrative_source": narrative_source,
            "narrative_verdict": narrative_verdict,
            "agent_raw_answer": raw_narrative,
        },
    })

    return {
        "question": question,
        "answer": answer_text,
        "source_deal_ids": cited_ids,
        "cited_record_refs": cited_ids,
        "grounded": ground["grounded"],
        "record_count": retrieve["record_count"],
        "subject": retrieve["subject"],
        "narrative_source": narrative_source,
        "session_id": rec["session_id"],
        "user_id": scope["user_id"],
        "role": scope["role"],
    }


@router.get("/api/qa/book-summary")
def qa_book_summary(
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """The desk's "Book at a Glance" tallies, computed from the same stored,
    permission-scoped deal records the answers are grounded in.

    These are portfolio figures (exposure, exception counts), so this read is
    guarded exactly like the ask: identity is required — 401 with none, 403 for
    an unknown caller or a role without `portfolio.query`."""
    email = acting_user_email or x_user_email
    identity.require_actor(email, QA_PERMISSION, "read the portfolio book summary")
    scope = resolve_qa_permission_scope({"inputs": {"acting_user_email": email, "question": ""}})
    records = _records_for(scope["visible_deal_ids"])
    facts = _portfolio_facts(records)
    return {
        "role": scope["role"],
        "deal_ids": [r["deal_id"] for r in records],
        "active_deals": facts["deal_count"],
        "total_exposure": facts["total_exposure"],
        "total_exposure_display": facts["total_exposure_display"],
        "open_exception_count": facts["open_exception_count"],
        "without_accepted_spread": facts["without_accepted_spread"],
        "by_stage": facts["by_stage"],
    }


def _session_projection(session, reader, visible_deal_ids, book_wide):
    """What `reader` may see of one recorded session.

    An unidentified caller gets the row's SHAPE and nothing else — no question,
    no answer, no deal id, no asker — mirroring the foundation's redacted board
    projection. An identified caller sees its own sessions in full, and the deal
    ids on any session are still intersected with what that role may see."""
    if identity.is_anonymous(reader):
        return {
            "id": session.get("id"),
            "user_id": None,
            "question": REDACTED,
            "grounded_response": REDACTED,
            "source_deal_ids": [],
            "created_at": session.get("created_at"),
            "redacted": True,
        }
    sources = [d for d in (session.get("source_deal_ids") or []) if d in visible_deal_ids]
    row = {
        "id": session.get("id"),
        "user_id": session.get("user_id"),
        "question": session.get("question"),
        "grounded_response": session.get("grounded_response"),
        "source_deal_ids": sources,
        "created_at": session.get("created_at"),
    }
    if book_wide:
        row["trace_data"] = session.get("trace_data")
    return row


@router.get("/api/qa/sessions")
def list_qa_sessions(
    acting_user_email: str | None = None,
    x_user_email: str | None = Header(default=None),
):
    """The Q&A session log, most-recent first — the audit read-back for R-029.

    The guard is UNCONDITIONAL and fail-closed (`identity.require_reader`, the
    same helper the deal book and pipeline board use): an identity that
    resolves to no stored user is a 403, an identified caller is scoped by role
    — the desk roles read the whole log, a relationship manager reads only its
    own sessions and only the deal ids it may see — and an UNIDENTIFIED caller
    reads the redacted projection: it can see that sessions exist and when, but
    never a question, an answer, an asker or a deal id."""
    reader = identity.require_reader(acting_user_email or x_user_email, action="read the Q&A session log")
    book_wide = identity.has_permission(reader, BOOK_WIDE_PERMISSION)
    visible_deal_ids = {
        d.get("deal_code")
        for d in identity.visible_deals(reader, deals_repo.all_current_deals())
    }
    sessions = list(reversed(store.list("portfolio_qa_sessions")))
    if not identity.is_anonymous(reader) and not book_wide:
        sessions = [s for s in sessions if s.get("user_id") == reader.get("id")]
    return [_session_projection(s, reader, visible_deal_ids, book_wide) for s in sessions]
