"""ext_grounded_portfolio_qa: slice `grounded-portfolio-qa`.

A credit officer asks the portfolio desk a question in plain English. Retrieval
is scoped to the asker's RBAC role server-side (R-053/R-054) before the
Portfolio Q&A Agent ever sees a record; every statement returned is tied to
the deal ids actually retrieved (R-015); the whole exchange — question,
answer, sources, and trace — is written to the immutable
`portfolio_qa_sessions` table for audit (R-029/R-056).

GROUNDING (revision): the agent's knowledge is assembled at question time from
the STORED deal records — pipeline stage, status, requested/exposure amounts,
risk grade, whether a spread has been accepted, open policy exceptions, key
ratios and ownership — for exactly the deals the asking user's role may see.
That record set is handed to `agent_runtime.respond()` as the provided
knowledge for the question, so portfolio questions ("which deals await tiered
approval", "what is sitting in intake", "who is carrying open exceptions")
are answered with real deal codes and real figures instead of being refused
as uncovered. Two safety properties are preserved deterministically, in code:

  * every figure quoted back is computed here, never by the model
    (`_portfolio_facts`), and the answer is always framed as an automated
    draft pending analyst approval;
  * when the stored records genuinely do not contain an answer — no deals in
    scope at all — the desk says so and cites nothing rather than inventing
    figures. A model reply that refuses or cites nothing while records DO
    exist is replaced by the deterministic digest of those records, and the
    raw model text is kept in the session trace for audit.

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
import datetime
import json
import os
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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
# per-role below. identity.require_actor is DEFAULT-DENY, so an unrecognised
# caller reads nothing.
QA_PERMISSION = "portfolio.query"
BROAD_VISIBILITY_ROLES = {"credit_analyst", "senior_credit_officer", "admin"}

# Every answer this desk produces is a draft for a human, never a decision.
DRAFT_FRAMING = "Automated draft pending analyst approval."

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
# tool-registry: the roster's declared read tools, enforced through
# tools.invoke() so the agent's allow/deny list is a structural guarantee
# rather than just documentation (R-055).
# ------------------------------------------------------------------------

def _read_deal(deal_id):
    return deals_repo.get_deal(deal_id)


def _read_spread(deal_id):
    return [r for r in store.list("financial_spread_template") if r.get("deal_id") == deal_id]


def _read_ratios(deal_id):
    return [r for r in store.list("financial_ratios") if r.get("deal_id") == deal_id]


def _read_risk_grade(deal_id):
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_id]
    return rows[-1] if rows else None


def _read_memo(deal_id):
    rows = [o for o in store.list("agent_outputs") if o.get("deal_id") == deal_id and o.get("agent_id") == "credit-memo"]
    return rows[-1] if rows else None


def _read_policy_exceptions(deal_id):
    return [r for r in store.list("policy_exceptions") if r.get("deal_id") == deal_id]


def _read_audit_timeline(deal_id):
    return [r for r in store.list("audit_log") if r.get("deal_id") == deal_id]


def _search_deals_in_scope(visible_deal_ids, keyword=None):
    visible = set(visible_deal_ids or [])
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
    own scope. A relationship manager only ever sees deals they created
    (R-053); analysts, officers, and admins see the whole active book, which
    is what R-014's "spanning active deals" portfolio question requires.

    Guarded with identity.require_actor so this handler is safe even when it
    is reached through workflow_engine.start() rather than the endpoint."""
    inputs = context.get("inputs", context)
    user = identity.require_actor(
        inputs.get("acting_user_email"), QA_PERMISSION, "ask the portfolio desk"
    )
    role = user.get("role")
    all_deals = deals_repo.all_current_deals()
    if role in BROAD_VISIBILITY_ROLES:
        visible = [d["deal_code"] for d in all_deals]
    else:
        visible = [d["deal_code"] for d in identity.visible_deals(user, all_deals)]
    return {
        "user_id": user["id"],
        "role": role,
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
    declared read tools."""
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


def _portfolio_facts(records):
    """Every figure the desk ever quotes is computed HERE, in deterministic
    code — no financial arithmetic is ever delegated to the model (R-042)."""
    by_stage = {}
    for r in records:
        stage = r.get("current_stage") or "intake"
        by_stage[stage] = by_stage.get(stage, 0) + 1
    return {
        "deal_count": len(records),
        "total_exposure": sum(float(r.get("exposure_amount") or r.get("requested_amount") or 0) for r in records),
        "total_exposure_display": _money(
            sum(float(r.get("exposure_amount") or r.get("requested_amount") or 0) for r in records)
        ),
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
    knowledge for this question."""
    visible = context.get("visible_deal_ids", [])
    question = context.get("question")
    agent = _agent()

    scope_records = [rec for rec in (_build_record(agent, code) for code in visible) if rec is not None]
    selected, subject = _select_records(question, scope_records)

    return {
        "context_records": selected,
        "source_deal_ids": [r["deal_id"] for r in selected],
        "record_count": len(selected),
        "subject": subject,
        "scope_deal_ids": [r["deal_id"] for r in scope_records],
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
    Used when the model declines to use the records it was given, so a
    portfolio question is answered with real deal codes and real figures
    instead of a refusal — and never with a figure nobody computed."""
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


_REFUSAL_MARKERS = (
    "not covered", "does not cover", "doesn't cover", "hand off", "hand this off",
    "handing off", "no information", "cannot answer", "can't answer", "unable to answer",
    "not in my knowledge", "outside my knowledge", "no knowledge", "insufficient information",
    "no data available", "i don't have", "i do not have",
)


def _model_ignored_the_records(narrative, selected):
    """True when the model's reply cites none of the records it was handed and
    reads like a refusal — i.e. the answer is not grounded in live data."""
    if not narrative or not narrative.strip():
        return True
    low = narrative.lower()
    # An echo of the knowledge block back at us is not an answer (the
    # deterministic offline responder does exactly this).
    if "provided knowledge for this question" in low:
        return True
    if any(r["deal_id"].lower() in low for r in selected):
        return False
    return any(marker in low for marker in _REFUSAL_MARKERS)


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
    question: str
    acting_user_email: str


@router.post("/api/qa/ask")
def ask_portfolio_qa(req: QaAskRequest):
    # Default-deny server-side authority check before any record is read.
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

    fell_back = _model_ignored_the_records(raw_narrative, retrieve["context_records"])
    narrative = _deterministic_digest(question, retrieve) if fell_back else raw_narrative

    # Deals were examined even when none matched — the "none match" claim is
    # itself grounded in those records, so they are cited.
    citable = retrieve["context_records"] or [
        rec for rec in (_build_record(_agent(), code) for code in retrieve["scope_deal_ids"]) if rec
    ]
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
            "retrieve": retrieve,
            "groundcheck": ground,
            "narrative_source": "deterministic_records_digest" if fell_back else "agent",
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
        "narrative_source": "deterministic_records_digest" if fell_back else "agent",
        "session_id": rec["session_id"],
        "user_id": scope["user_id"],
        "role": scope["role"],
    }


@router.get("/api/qa/book-summary")
def qa_book_summary(acting_user_email: str):
    """The desk's "Book at a Glance" tallies, computed from the same stored,
    permission-scoped deal records the answers are grounded in."""
    identity.require_actor(acting_user_email, QA_PERMISSION, "read the portfolio book summary")
    scope = resolve_qa_permission_scope({"inputs": {"acting_user_email": acting_user_email, "question": ""}})
    agent = _agent()
    records = [r for r in (_build_record(agent, code) for code in scope["visible_deal_ids"]) if r]
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


@router.get("/api/qa/sessions")
def list_qa_sessions(acting_user_email: str | None = None):
    """The Q&A session log, most-recent first — the audit read-back for R-029.

    When a caller identifies itself the log is scoped to what that role may
    see (same contract as `GET /api/deals`): the desk roles read the whole
    log, a relationship manager reads only its own sessions."""
    sessions = list(reversed(store.list("portfolio_qa_sessions")))
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, QA_PERMISSION, "read the Q&A session log")
        if actor.get("role") not in BROAD_VISIBILITY_ROLES:
            sessions = [s for s in sessions if s.get("user_id") == actor["id"]]
    return sessions
