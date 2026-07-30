"""portfolio-qa-sla-audit slice: grounded portfolio Q&A portion.

Implements the `portfolio-qa` workflow (workflows/workflows.json):
capture_question -> resolve_scope -> plan_query (agent) -> execute_query ->
[check_has_results] -> compose_answer (agent) -> record_answer ->
[check_answer_complete] / record_no_results. The five deterministic nodes
are registered as real workflow_engine handlers under the exact names the
workflow definition calls out.

Like every earlier slice, the two "agent" nodes here (plan_query,
compose_answer) never determine what the system actually does: this
workflow's own opportunity-map rationale is explicit that "execution [is]
left to scoped, read-only code" and that the answering agent's job is to
restate rows the deterministic query already retrieved — so
`execute_scoped_deal_query` parses the question's filters itself (regex over
amount/DSCR/leverage/current-ratio/grade/SLA/stage keywords — deterministic,
reproducible, never inferred by a model) and `record_qa_answer` composes the
grounded answer text from the retrieved rows themselves. The agent replies
are folded in only as an advisory `agent_rationale` on the stored answer
row and in the audit trail description, exactly like the triage/spread
agents' narrative-only role elsewhere in this codebase.

Composition contract:
  * storage  -> db.store only. `_portfolio_questions` / `_portfolio_answers`
                are new tables outside the approved data model, following
                the same precedent as row-history's `_row_history` and
                workflow-engine's `_wf_events` — infra bookkeeping the
                generic /api/{table} route was never meant to expose, never
                hand-rolled storage. Every answer is ALSO written to the
                approved `audit_trail` table (REQ-042) so "each question and
                answer is logged with your identity attached" (the design's
                own Guardrails panel copy) is literally true.
  * scoping  -> REQ-028/048: reuses ext_deals.DEAL_RLS_POLICY via the same
                composed row-level-security module every other slice scopes
                deals through — a relationship manager asking a portfolio
                question only ever sees their own submitted deals; the
                planner/answerer agents never see a row outside that scope
                because execute_scoped_deal_query filters BEFORE either
                agent is ever called.
  * grounding -> REQ-026: answer_text is built only from the rows
                execute_scoped_deal_query actually retrieved; every cited
                deal id is drawn from that same result set, never from the
                agent's own text.
  * routes   -> mounted outside /api/ so the /api/{table} catch-all in
                main.py can never shadow them.
"""
import re
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import rls
import workflow_engine
from db import store
from deal_state import STAGE_ORDER
from ext_approvals import USER_AUTHORITY
from ext_audit import record as system_audit
from ext_deals import DEAL_RLS_POLICY

router = APIRouter()

SLA_THRESHOLD_BUSINESS_DAYS = 5


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _money(value):
    n = value if isinstance(value, (int, float)) else None
    if n is None:
        return "—"
    return "${:,.0f}".format(n)


def _role_for(user_id):
    entry = USER_AUTHORITY.get(user_id)
    return entry["role"] if entry else "unknown"


def _scope_deals_for(user_id):
    all_deals = store.list("deals")
    if user_id is None:
        return list(all_deals)
    return rls.scope(all_deals, user_id, DEAL_RLS_POLICY)


def _business_days_idle(last_activity_iso):
    """Same rubric as ext_sla.py's SLA dashboard (kept as a small, deliberate
    duplicate rather than a cross-slice import — see that module's
    docstring for why this is a separate calculation from sla.status())."""
    import datetime

    if not last_activity_iso:
        return 0
    start = datetime.datetime.fromisoformat(str(last_activity_iso).replace("Z", "+00:00")).date()
    now_date = datetime.datetime.now(datetime.timezone.utc).date()
    if now_date <= start:
        return 0
    count = 0
    d = start
    while d < now_date:
        d += datetime.timedelta(days=1)
        if d.weekday() < 5:
            count += 1
    return count


def _row_for_deal(deal):
    deal_id = deal["deal_id"]
    ratios = {r["ratio_type"]: r["computed_value"] for r in store.list("credit_ratios") if r["deal_id"] == deal_id}
    grades = [g for g in store.list("risk_grades") if g["deal_id"] == deal_id]
    grade = grades[-1]["grade"] if grades else None
    open_exceptions = [
        e for e in store.list("policy_exceptions")
        if e["deal_id"] == deal_id and e.get("exception_status") not in ("waived", "resolved")
    ]
    idle = _business_days_idle(deal.get("last_activity_at"))
    return {
        "deal_id": deal_id,
        "borrower_name": deal.get("borrower_name"),
        "industry": deal.get("industry"),
        "requested_amount": deal.get("requested_amount"),
        "current_stage": deal.get("current_stage"),
        "status": deal.get("status"),
        "dscr": ratios.get("dscr"),
        "leverage": ratios.get("leverage"),
        "current_ratio": ratios.get("current_ratio"),
        "risk_grade": grade,
        "open_exception_count": len(open_exceptions),
        "business_days_idle": idle,
        "is_over_sla": idle > SLA_THRESHOLD_BUSINESS_DAYS,
    }


_AMOUNT_UNITS = {"k": 1_000, "thousand": 1_000, "m": 1_000_000, "million": 1_000_000}


def _to_amount(num_str, unit):
    n = float(num_str.replace(",", ""))
    if unit:
        n *= _AMOUNT_UNITS.get(unit.lower(), 1)
    return n


def _parse_filters(question_text):
    """Deterministic keyword/regex filter extraction — the same pattern
    ext_deals.py's _classify_request uses for triage, applied here instead
    of trusting the Portfolio Query Planner agent's JSON (which, like every
    other agent node in this codebase, is advisory only)."""
    q = (question_text or "").lower()
    filters = {}

    m = re.search(r"(?:above|over|greater than|more than|at least)\s*\$\s*([\d,.]+)\s*(k|m|million|thousand)?", q)
    if m:
        filters["amount_gt"] = _to_amount(m.group(1), m.group(2))
    m = re.search(r"(?:below|under|less than|at most)\s*\$\s*([\d,.]+)\s*(k|m|million|thousand)?", q)
    if m:
        filters["amount_lt"] = _to_amount(m.group(1), m.group(2))

    m = re.search(r"dscr[^0-9]{0,15}(?:under|below|less than|<)\s*([\d.]+)", q)
    if m:
        filters["dscr_lt"] = float(m.group(1))
    m = re.search(r"dscr[^0-9]{0,15}(?:over|above|greater than|>)\s*([\d.]+)", q)
    if m:
        filters["dscr_gt"] = float(m.group(1))

    m = re.search(r"leverage[^0-9]{0,15}(?:under|below|less than|<)\s*([\d.]+)", q)
    if m:
        filters["leverage_lt"] = float(m.group(1))
    m = re.search(r"leverage[^0-9]{0,15}(?:over|above|greater than|>)\s*([\d.]+)", q)
    if m:
        filters["leverage_gt"] = float(m.group(1))

    m = re.search(r"current ratio[^0-9]{0,15}(?:under|below|less than|<)\s*([\d.]+)", q)
    if m:
        filters["current_ratio_lt"] = float(m.group(1))
    m = re.search(r"current ratio[^0-9]{0,15}(?:over|above|greater than|>)\s*([\d.]+)", q)
    if m:
        filters["current_ratio_gt"] = float(m.group(1))

    m = re.search(r"\bgrade\s*([1-8])\b", q)
    if m:
        filters["grade_eq"] = int(m.group(1))

    if re.search(r"over\s*sla|breach(ed|ing)?|past\s*(the\s*)?sla", q):
        filters["is_over_sla"] = True

    m = re.search(r"idle\s*(?:more than|over|past|longer than)\s*([\d.]+)\s*business", q)
    if m:
        filters["idle_gt"] = float(m.group(1))

    for stage in STAGE_ORDER:
        if stage.replace("_", " ") in q or re.search(r"\b" + re.escape(stage) + r"\b", q):
            filters["stage_eq"] = stage
            break

    return filters


def _matches(row, filters):
    checks = {
        "amount_gt": lambda: row.get("requested_amount") is not None and row["requested_amount"] > filters["amount_gt"],
        "amount_lt": lambda: row.get("requested_amount") is not None and row["requested_amount"] < filters["amount_lt"],
        "dscr_gt": lambda: row.get("dscr") is not None and row["dscr"] > filters["dscr_gt"],
        "dscr_lt": lambda: row.get("dscr") is not None and row["dscr"] < filters["dscr_lt"],
        "leverage_gt": lambda: row.get("leverage") is not None and row["leverage"] > filters["leverage_gt"],
        "leverage_lt": lambda: row.get("leverage") is not None and row["leverage"] < filters["leverage_lt"],
        "current_ratio_gt": lambda: row.get("current_ratio") is not None and row["current_ratio"] > filters["current_ratio_gt"],
        "current_ratio_lt": lambda: row.get("current_ratio") is not None and row["current_ratio"] < filters["current_ratio_lt"],
        "grade_eq": lambda: row.get("risk_grade") == filters["grade_eq"],
        "is_over_sla": lambda: bool(row.get("is_over_sla")) == filters["is_over_sla"],
        "idle_gt": lambda: (row.get("business_days_idle") or 0) > filters["idle_gt"],
        "stage_eq": lambda: row.get("current_stage") == filters["stage_eq"],
    }
    return all(checks[k]() for k in filters if k in checks)


def _compose_answer_text(rows):
    if not rows:
        return "No deals in your visible portfolio match this question.", []
    total_exposure = sum(r.get("requested_amount") or 0 for r in rows)
    ids = [r["deal_id"] for r in rows]
    lines = []
    for r in rows[:10]:
        bits = [r["deal_id"], r.get("borrower_name") or "", _money(r.get("requested_amount"))]
        if r.get("dscr") is not None:
            bits.append("DSCR {:.2f}x".format(r["dscr"]))
        if r.get("risk_grade") is not None:
            bits.append("grade {}".format(r["risk_grade"]))
        bits.append("stage {}".format(r.get("current_stage")))
        lines.append(" — ".join(str(b) for b in bits if b))
    summary = "{} deal(s) match, combined exposure {}: {}".format(len(rows), _money(total_exposure), "; ".join(lines))
    if len(rows) > 10:
        summary += "; and {} more.".format(len(rows) - 10)
    return summary, ids


# --------------------------------------------------------------------------
# workflow handlers — portfolio-qa
# --------------------------------------------------------------------------

def capture_portfolio_question(context):
    inputs = context.get("inputs") or {}
    question_text = (inputs.get("question") or "").strip()
    if not question_text:
        raise workflow_engine.WorkflowError("question is required")
    asking_user_id = inputs.get("asked_by_id") or inputs.get("asking_user_id")
    role = _role_for(asking_user_id)
    row = store.insert(
        "_portfolio_questions",
        {"question_text": question_text, "asking_user_id": asking_user_id, "asking_user_role": role, "created_at": _now_iso()},
    )
    return {
        "question_id": row["id"],
        "question_text": question_text,
        "asking_user_id": asking_user_id,
        "asking_user_role": role,
    }


def resolve_user_visibility_scope(context):
    capture = context.get("capture_question") or {}
    asking_user_id = capture.get("asking_user_id")
    scoped = _scope_deals_for(asking_user_id)
    portfolio_wide = len(scoped) == len(store.list("deals"))
    return {
        "asking_user_id": asking_user_id,
        "scope_filter": {
            "owner_field": DEAL_RLS_POLICY["owner_field"],
            "bypass_roles": DEAL_RLS_POLICY["bypass_roles"],
            "portfolio_wide": portfolio_wide,
        },
        "visible_deal_count": len(scoped),
    }


def execute_scoped_deal_query(context):
    capture = context.get("capture_question") or {}
    question_text = capture.get("question_text") or ""
    asking_user_id = capture.get("asking_user_id")
    scoped_deals = _scope_deals_for(asking_user_id)
    filters = _parse_filters(question_text)
    rows = [_row_for_deal(d) for d in scoped_deals]
    rows = [r for r in rows if _matches(r, filters)]
    result_deal_ids = [r["deal_id"] for r in rows]
    return {
        "question_id": capture.get("question_id"),
        "result_rows": rows,
        "result_deal_ids": result_deal_ids,
        "row_count": len(rows),
        "has_results": len(rows) > 0,
        "scope_applied": {"visible_deal_count": len(scoped_deals), "filters_applied": filters},
    }


def record_qa_answer(context):
    capture = context.get("capture_question") or {}
    execute = context.get("execute_query") or {}
    rows = execute.get("result_rows") or []
    answer_text, cited = _compose_answer_text(rows)
    agent_reply = (context.get("compose_answer") or context.get("plan_query") or {}).get("reply", "")
    now = _now_iso()
    citations_within_scope = all(d in (execute.get("result_deal_ids") or []) for d in cited)
    row = store.insert(
        "_portfolio_answers",
        {
            "question_id": capture.get("question_id"),
            "answer_text": answer_text,
            "cited_deal_ids": cited,
            "citations_within_scope": citations_within_scope,
            "answer_status": "recorded",
            "agent_rationale": agent_reply,
            "created_at": now,
        },
    )
    system_audit("portfolio_qa.answered", {"question_id": capture.get("question_id"), "asking_user_id": capture.get("asking_user_id"), "cited_deal_ids": cited})
    store.insert(
        "audit_trail",
        {
            "deal_id": None,
            "actor_id": capture.get("asking_user_id"),
            "actor_type": "human",
            "event_type": "portfolio_qa.answered",
            "timestamp": now,
            "before_value": None,
            "after_value": {"cited_deal_ids": cited, "row_count": len(rows)},
            "description": 'Portfolio Q&A: "{}" -> {}'.format(capture.get("question_text"), answer_text),
        },
    )
    return {
        "question_id": capture.get("question_id"),
        "answer_id": row["id"],
        "cited_deal_ids": cited,
        "citations_within_scope": citations_within_scope,
        "answer_status": "recorded",
        "answer_text": answer_text,
    }


def record_qa_no_results(context):
    capture = context.get("capture_question") or {}
    message = "No deals in your visible portfolio match this question."
    now = _now_iso()
    row = store.insert(
        "_portfolio_answers",
        {
            "question_id": capture.get("question_id"),
            "answer_text": message,
            "cited_deal_ids": [],
            "citations_within_scope": True,
            "answer_status": "no_results",
            "created_at": now,
        },
    )
    system_audit("portfolio_qa.no_results", {"question_id": capture.get("question_id"), "asking_user_id": capture.get("asking_user_id")})
    store.insert(
        "audit_trail",
        {
            "deal_id": None,
            "actor_id": capture.get("asking_user_id"),
            "actor_type": "human",
            "event_type": "portfolio_qa.no_results",
            "timestamp": now,
            "before_value": None,
            "after_value": None,
            "description": 'Portfolio Q&A: "{}" -> no matching deals'.format(capture.get("question_text")),
        },
    )
    return {
        "question_id": capture.get("question_id"),
        "answer_id": row["id"],
        "message": message,
        "answer_status": "no_results",
    }


for _name, _fn in [
    ("capture_portfolio_question", capture_portfolio_question),
    ("resolve_user_visibility_scope", resolve_user_visibility_scope),
    ("execute_scoped_deal_query", execute_scoped_deal_query),
    ("record_qa_answer", record_qa_answer),
    ("record_qa_no_results", record_qa_no_results),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface
# --------------------------------------------------------------------------

class PortfolioQARequest(BaseModel):
    question: str
    asked_by_id: str


@router.post("/portfolio/qa")
def portfolio_qa(req: PortfolioQARequest):
    context = {"inputs": {"question": req.question, "asked_by_id": req.asked_by_id}}
    try:
        capture = capture_portfolio_question(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    context["capture_question"] = capture
    scope = resolve_user_visibility_scope(context)
    context["resolve_scope"] = scope
    execute = execute_scoped_deal_query(context)
    context["execute_query"] = execute

    # Portfolio Query Planner: advisory narrative only — execute_query above
    # already parsed the question deterministically before this ever runs.
    planner_prompt = (
        "You are the portfolio Q&A planning agent. Translate the question \"{}\" into a structured "
        "READ-ONLY query plan over deal data, under visibility scope {}. You may not write, update, "
        "delete or advance anything.".format(capture["question_text"], scope["scope_filter"])
    )
    context["plan_query"] = {"reply": agent_runtime.respond(planner_prompt, agent_name="Portfolio Query Planner")}

    if execute["has_results"]:
        answerer_prompt = (
            "You are the portfolio Q&A answering agent. Answer \"{}\" using ONLY these {} retrieved rows: "
            "{}. Cite the deal id behind every figure.".format(capture["question_text"], execute["row_count"], execute["result_rows"])
        )
        context["compose_answer"] = {"reply": agent_runtime.respond(answerer_prompt, agent_name="Portfolio Answer Agent")}
        result = record_qa_answer(context)
        answer_text, supporting = result["answer_text"], result["cited_deal_ids"]
    else:
        result = record_qa_no_results(context)
        answer_text, supporting = result["message"], []

    return {
        "question": capture["question_text"],
        "asked_by_id": req.asked_by_id,
        "asking_user_role": capture["asking_user_role"],
        "answer": answer_text,
        "supporting_deal_ids": supporting,
        "read_only": True,
        "row_count": execute["row_count"],
        "visible_deal_count": scope["visible_deal_count"],
        "filters_applied": execute["scope_applied"]["filters_applied"],
    }


@router.get("/portfolio/questions")
def recent_questions(limit: int = 20):
    """Backs the Q&A screen's "recent questions" panel with real history."""
    questions = store.list("_portfolio_questions")
    answers = {a["question_id"]: a for a in store.list("_portfolio_answers")}
    rows = []
    for q in questions[-limit:][::-1]:
        answer = answers.get(q["id"])
        rows.append(
            {
                "question_id": q["id"],
                "question_text": q["question_text"],
                "asking_user_id": q["asking_user_id"],
                "asking_user_role": q["asking_user_role"],
                "created_at": q["created_at"],
                "answer_text": answer["answer_text"] if answer else None,
                "cited_deal_ids": answer["cited_deal_ids"] if answer else [],
            }
        )
    return rows
