"""ext_grounded_portfolio_qa: slice `grounded-portfolio-qa`.

A credit officer asks the portfolio desk a question in plain English. Retrieval
is scoped to the asker's RBAC role server-side (R-053/R-054) before the
Portfolio Q&A Agent ever sees a record; every statement returned is tied to
the deal ids actually retrieved (R-015); the whole exchange — question,
answer, sources, and trace — is written to the immutable
`portfolio_qa_sessions` table for audit (R-029/R-056).

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
CAN_ASK = {"relationship_manager", "credit_analyst", "senior_credit_officer", "admin"}
BROAD_VISIBILITY_ROLES = {"credit_analyst", "senior_credit_officer", "admin"}

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
    is what R-014's "spanning active deals" portfolio question requires."""
    inputs = context.get("inputs", context)
    user = identity.resolve_user(inputs.get("acting_user_email"))
    role = user.get("role") if user else None
    all_deals = deals_repo.all_current_deals()
    if role == "relationship_manager":
        visible = [d["deal_code"] for d in all_deals if user and d.get("created_by_user_id") == user["id"]]
    elif role in BROAD_VISIBILITY_ROLES:
        visible = [d["deal_code"] for d in all_deals]
    else:
        visible = []
    return {
        "user_id": user["id"] if user else None,
        "role": role,
        "question": inputs.get("question"),
        "visible_deal_ids": sorted(visible),
        "scope_is_empty": len(visible) == 0,
    }


workflow_engine.register_handler("resolve_qa_permission_scope", resolve_qa_permission_scope)


def _relevant_deal_ids(question, visible_deal_ids):
    """Deterministic filter over the already-scoped deal ids: which of them
    actually bear on this question. Never widens `visible_deal_ids` — only
    narrows it — so R-054's cap always holds."""
    q = (question or "").lower()
    agent = _agent()
    if "spread" in q and any(w in q for w in ("lack", "missing", "without", "no accepted", "not accepted", "unaccepted")):
        return [code for code in visible_deal_ids if not tools.invoke(agent, "read_spread", deal_id=code)]
    if "exception" in q or "policy" in q:
        return [
            code for code in visible_deal_ids
            if any(e.get("status") == "open" for e in tools.invoke(agent, "read_policy_exceptions", deal_id=code))
        ]
    found = tools.invoke(agent, "search_deals_in_scope", visible_deal_ids=visible_deal_ids)
    return [d["deal_code"] for d in found]


def retrieve_grounded_deal_context(context):
    """Node `retrieve`: R-015 grounds answers in stored deal data, capped at
    the scope resolved above — record selection stays in code the agent
    cannot widen (R-054)."""
    visible = context.get("visible_deal_ids", [])
    question = context.get("question")
    agent = _agent()
    relevant = _relevant_deal_ids(question, visible)
    records = []
    for code in relevant:
        deal = tools.invoke(agent, "read_deal", deal_id=code)
        if deal is None:
            continue
        spread_rows = tools.invoke(agent, "read_spread", deal_id=code)
        grade = tools.invoke(agent, "read_risk_grade", deal_id=code)
        exceptions = tools.invoke(agent, "read_policy_exceptions", deal_id=code)
        records.append({
            "deal_id": code,
            "borrower_name": deal.get("borrower_name"),
            "current_stage": deal.get("current_stage"),
            "current_status": deal.get("current_status"),
            "requested_amount": deal.get("requested_amount"),
            "exposure_amount": deal.get("exposure_amount"),
            "risk_grade": (grade or {}).get("grade") if grade else deal.get("risk_grade"),
            "has_accepted_spread": bool(spread_rows),
            "open_policy_exceptions": len([e for e in exceptions if e.get("status") == "open"]),
        })
    return {
        "context_records": records,
        "source_deal_ids": [r["deal_id"] for r in records],
        "record_count": len(records),
    }


workflow_engine.register_handler("retrieve_grounded_deal_context", retrieve_grounded_deal_context)


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
    entry = audit("qa.session_recorded", {
        "actor_user_id": context["user_id"],
        "resource_type": "portfolio_qa_session",
        "resource_id": row["id"],
        "after": {"question": context["question"], "source_deal_ids": context["source_deal_ids"]},
    })
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
    actor = identity.resolve_user(req.acting_user_email, default_role="credit_analyst")
    if actor is None or actor.get("role") not in CAN_ASK:
        raise HTTPException(status_code=403, detail="your role lacks authority to use the portfolio desk")

    scope = resolve_qa_permission_scope({"inputs": {"acting_user_email": req.acting_user_email, "question": req.question}})
    question = req.question or ""

    # Identity questions are about the agent, not a deal claim — answered
    # directly, skipping retrieval and grounding entirely.
    if any(p.search(question) for p in IDENTITY_PATTERNS):
        narrative = agent_runtime.respond(
            f"A user asked: '{question}'. Identify yourself by name and role in one sentence.",
            agent_name=PORTFOLIO_AGENT_NAME,
        )
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

    if scope["scope_is_empty"]:
        answer = f"[{PORTFOLIO_AGENT_NAME}] You have no deals in scope to answer from."
        rec = record_qa_session({
            "user_id": scope["user_id"], "question": question, "answer": answer,
            "source_deal_ids": [], "trace_data": {"scope": scope},
        })
        return {
            "question": question, "answer": answer, "source_deal_ids": [], "cited_record_refs": [],
            "grounded": False, "session_id": rec["session_id"], "user_id": scope["user_id"], "role": scope["role"],
        }

    retrieve = retrieve_grounded_deal_context({"visible_deal_ids": scope["visible_deal_ids"], "question": question})

    prompt = (
        f"You are the portfolio Q&A agent. Answer this credit officer question using ONLY the "
        f"supplied deal records — never model recall or outside knowledge: \"{question}\". "
        f"Records in scope: {retrieve['context_records']} (deals {retrieve['source_deal_ids']}). "
        "Cite the deal id behind every claim. If the records do not support an answer, say so and "
        "name what is missing. You may not approve, decline, or advance any deal."
    )
    narrative = agent_runtime.respond(prompt, agent_name=PORTFOLIO_AGENT_NAME)
    answer_text, cited_ids, _sourced = _build_answer(narrative, retrieve["context_records"])
    unsupported = [] if retrieve["context_records"] else ["no deal records in scope support this question"]

    ground = verify_answer_grounding({
        "cited_record_refs": cited_ids,
        "visible_deal_ids": scope["visible_deal_ids"],
        "unsupported_claims": unsupported,
    })

    rec = record_qa_session({
        "user_id": scope["user_id"],
        "question": question,
        "answer": answer_text,
        "source_deal_ids": retrieve["source_deal_ids"],
        "trace_data": {"scope": scope, "retrieve": retrieve, "groundcheck": ground},
    })

    return {
        "question": question,
        "answer": answer_text,
        "source_deal_ids": retrieve["source_deal_ids"],
        "cited_record_refs": cited_ids,
        "grounded": ground["grounded"],
        "record_count": retrieve["record_count"],
        "session_id": rec["session_id"],
        "user_id": scope["user_id"],
        "role": scope["role"],
    }


@router.get("/api/qa/sessions")
def list_qa_sessions():
    """Every Q&A session, most-recent first — the audit read-back for R-029."""
    return list(reversed(store.list("portfolio_qa_sessions")))
