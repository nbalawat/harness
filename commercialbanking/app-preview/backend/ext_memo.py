"""memo-policy-compliance slice, part 1: cited credit memo drafting.

Implements the credit-memo portion of the approved `deal-underwriting`
workflow (workflows/workflows.json): draft_memo (agent) -> persist_memo_draft
-> [review_memo: human] -> apply_memo_decision -> check_memo_accepted. The
two deterministic nodes are registered as real workflow_engine handlers
under the exact names the workflow definition calls out.

The REST surface below (/deals/{id}/memo/run, /deals/{id}/memo/accept) calls
those SAME handler functions directly with a hand-built context, matching
every prior slice's pattern: the acceptance contract needs distinct propose
/ human-reviews-beside-citations / accept steps rather than the one-shot
chain the generic engine would run.

Composition contract:
  * storage -> db.store only (credit_memo_drafts, audit_trail)
  * process -> deal_state.machine owns the credit_memo_review ->
               policy_compliance_review transition
  * agent   -> agent_runtime.respond() carries the Credit Memo Agent's
               narrative only. Every citation (ratio id, spread line item
               id, policy rule id) is resolved deterministically against
               stored records — never invented or paraphrased by the model
               — matching the provenance pattern used by every prior slice
               (REQ-019: citations traceable back to the stored values).
  * gate    -> a memo cannot be drafted until the deal has an accepted
               spread, computed ratios and an assigned risk grade (REQ-038:
               only human-accepted output feeds downstream stages).
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in
               main.py can never shadow them
"""
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import workflow_engine
from db import store
from deal_state import machine as stage_machine
from ext_audit import record as system_audit
from ext_policy import applicable_ltv_rule
from statemachine import IllegalTransition

router = APIRouter()


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _fmt(value):
    return f"{value:.2f}" if isinstance(value, (int, float)) else "n/a"


def _get_deal(deal_id):
    for row in store.list("deals"):
        if row.get("deal_id") == deal_id:
            return row
    return None


def _get_deal_or_404(deal_id):
    deal = _get_deal(deal_id)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal '{deal_id}'")
    return deal


def _audit(deal_id, event_type, actor_id, actor_type, before=None, after=None, description=""):
    row = store.insert(
        "audit_trail",
        {
            "deal_id": deal_id,
            "actor_id": actor_id,
            "actor_type": actor_type,
            "event_type": event_type,
            "timestamp": _now_iso(),
            "before_value": before,
            "after_value": after,
            "description": description,
        },
    )
    system_audit(f"deal.{event_type}", {"deal_id": deal_id, "actor_id": actor_id, "actor_type": actor_type})
    return row


def _latest_ratios(deal_id):
    latest = {}
    for row in store.list("credit_ratios"):
        if row["deal_id"] == deal_id:
            latest[row["ratio_type"]] = row
    return latest


def _latest_grade(deal_id):
    rows = [r for r in store.list("risk_grades") if r["deal_id"] == deal_id]
    return rows[-1] if rows else None


def _accepted_spread_items(deal_id):
    return [r for r in store.list("spread_line_items") if r["deal_id"] == deal_id and r.get("accepted_value") is not None]


def _latest_memo(deal_id):
    rows = [r for r in store.list("credit_memo_drafts") if r["deal_id"] == deal_id]
    return rows[-1] if rows else None


# --------------------------------------------------------------------------
# workflow handlers — deal-underwriting (this slice's portion)
# --------------------------------------------------------------------------

def persist_memo_draft(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to draft a memo for")

    ratios = _latest_ratios(deal_id)
    grade = _latest_grade(deal_id)
    if not ratios or grade is None:
        raise workflow_engine.WorkflowError(
            f"deal '{deal_id}' has no accepted spread/computed ratios/risk grade to draft a memo from"
        )
    spread_items = _accepted_spread_items(deal_id)

    cited_ratios = [r["id"] for r in ratios.values()]
    cited_spread_items = [r["id"] for r in spread_items]
    ltv_rule = applicable_ltv_rule(deal.get("collateral_description") or "")
    cited_policy_rules = [ltv_rule["id"]] if ltv_rule else []

    dscr = (ratios.get("dscr") or {}).get("computed_value")
    leverage = (ratios.get("leverage") or {}).get("computed_value")
    current_ratio = (ratios.get("current_ratio") or {}).get("computed_value")
    agent_reply = (context.get("draft_memo") or {}).get("reply", "")
    content = (
        f"Underwriting memo for {deal.get('borrower_name')} ({deal_id}) — requested exposure "
        f"${(deal.get('requested_amount') or 0):,.0f}, LTV {deal.get('ltv_percentage')}%. "
        f"DSCR {_fmt(dscr)}x [ratio #{(ratios.get('dscr') or {}).get('id')}], "
        f"leverage {_fmt(leverage)}x [ratio #{(ratios.get('leverage') or {}).get('id')}], "
        f"current ratio {_fmt(current_ratio)} [ratio #{(ratios.get('current_ratio') or {}).get('id')}]. "
        f"Risk grade {grade['grade']} assigned by rule: {grade['rubric_rule_applied']}. "
        f"Accepted spread lines relied on: {', '.join('#' + str(i) for i in cited_spread_items) or 'none'}. "
        + (f"Applicable policy: '{ltv_rule['rule_name']}' [policy #{ltv_rule['id']}]. " if ltv_rule else "")
        + f"Agent notes: {agent_reply}"
    )
    now = _now_iso()
    row = store.insert(
        "credit_memo_drafts",
        {
            "deal_id": deal_id,
            "content": content,
            "cited_ratios": cited_ratios,
            "cited_spread_items": cited_spread_items,
            "cited_policy_rules": cited_policy_rules,
            "draft_status": "pending",
            "created_at": now,
            "accepted_at": None,
            "accepted_by_id": None,
            "generated_by_agent_id": "credit-memo-agent",
        },
    )
    citations_resolvable = (
        all(rid in {r["id"] for r in ratios.values()} for rid in cited_ratios)
        and all(sid in {i["id"] for i in spread_items} for sid in cited_spread_items)
        and (ltv_rule is None or ltv_rule["id"] in cited_policy_rules)
    )
    entry = _audit(
        deal_id,
        "memo.drafted",
        "credit-memo-agent",
        "agent",
        after={
            "memo_draft_id": row["id"],
            "cited_ratios": cited_ratios,
            "cited_spread_items": cited_spread_items,
            "cited_policy_rules": cited_policy_rules,
        },
        description=content,
    )
    return {
        "deal_id": deal_id,
        "memo_draft_id": row["id"],
        "content": content,
        "cited_ratios": cited_ratios,
        "cited_spread_items": cited_spread_items,
        "cited_policy_rules": cited_policy_rules,
        "draft_status": "pending",
        "citations_resolvable": citations_resolvable,
        "audit_entry_id": entry["id"],
    }


def apply_memo_review_decision(context):
    record = context.get("record_intake") or {}
    draft = context.get("persist_memo_draft") or {}
    deal_id = record.get("deal_id") or draft.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to decide memo for")

    decision_details = context.get("decision_details") or {}
    decision = (decision_details.get("decision") or "accept").lower()
    accepted_by_id = decision_details.get("accepted_by_id")

    memo_row = _latest_memo(deal_id)
    if memo_row is None or memo_row.get("draft_status") != "pending":
        raise workflow_engine.WorkflowError(f"no pending memo draft for deal '{deal_id}'")

    status = "accepted" if decision == "accept" else "returned_for_rework"
    now = _now_iso()
    before_status = memo_row["draft_status"]
    memo_row["draft_status"] = status
    memo_row["accepted_by_id"] = accepted_by_id
    if status == "accepted":
        memo_row["accepted_at"] = now

    _audit(
        deal_id,
        f"memo.{status}",
        accepted_by_id,
        "human",
        before={"draft_status": before_status},
        after={"draft_status": status},
        description=f"Credit memo {status} by {accepted_by_id}.",
    )

    if status == "accepted":
        previous_stage = deal["current_stage"]
        try:
            new_stage = stage_machine.advance(previous_stage, "accept_memo")
        except IllegalTransition as e:
            raise workflow_engine.WorkflowError(str(e))
        deal["current_stage"] = new_stage
        deal["last_activity_at"] = now
        _audit(
            deal_id,
            "deal.stage_advanced",
            accepted_by_id,
            "human",
            before={"current_stage": previous_stage},
            after={"current_stage": new_stage},
            description=f"Deal advanced to '{new_stage}' after memo acceptance.",
        )

    return {
        "deal_id": deal_id,
        "memo_status": status,
        "accepted_memo_id": memo_row["id"] if status == "accepted" else None,
        "accepted_by_id": accepted_by_id,
        "accepted_at": now,
        "current_stage": deal["current_stage"],
        "memo": memo_row,
    }


for _name, _fn in [
    ("persist_memo_draft", persist_memo_draft),
    ("apply_memo_review_decision", apply_memo_review_decision),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class MemoAcceptRequest(BaseModel):
    decision: str = "accept"
    accepted_by_id: str


@router.post("/deals/{deal_id}/memo/run")
def memo_run(deal_id: str):
    deal = _get_deal_or_404(deal_id)
    ratios = _latest_ratios(deal_id)
    grade = _latest_grade(deal_id)
    if not ratios or grade is None:
        raise HTTPException(status_code=400, detail="ratios and risk grade must be computed before drafting a memo")
    spread_items = _accepted_spread_items(deal_id)
    context = {"record_intake": {"deal_id": deal_id, "borrower_name": deal.get("borrower_name")}}
    prompt = (
        f"You are the credit memo agent for deal {deal_id} (borrower {deal.get('borrower_name')}, industry "
        f"{deal.get('industry')}, requested exposure {deal.get('requested_amount')}). Draft the underwriting memo "
        f"using ONLY the accepted spread line items {[i['id'] for i in spread_items]}, the computed ratios DSCR "
        f"{(ratios.get('dscr') or {}).get('computed_value')} / leverage {(ratios.get('leverage') or {}).get('computed_value')} "
        f"/ current ratio {(ratios.get('current_ratio') or {}).get('computed_value')}, and risk grade {grade['grade']} "
        f"assigned by rule {grade['rubric_rule_applied']}. Cite the specific ratio ids, spread line item ids, and "
        "policy rule ids behind every claim. Do not recompute any ratio, do not change the grade, do not recommend "
        "an approval decision. Return a draft only; a human reviewer will accept, edit, or reject it."
    )
    context["draft_memo"] = {"reply": agent_runtime.respond(prompt, agent_name="Credit Memo Agent")}
    try:
        result = persist_memo_draft(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.post("/deals/{deal_id}/memo/accept")
def memo_accept(deal_id: str, req: MemoAcceptRequest):
    _get_deal_or_404(deal_id)
    memo_row = _latest_memo(deal_id)
    if memo_row is None or memo_row.get("draft_status") != "pending":
        raise HTTPException(status_code=400, detail="no pending memo draft for this deal")
    context = {
        "record_intake": {"deal_id": deal_id},
        "decision_details": {"decision": req.decision, "accepted_by_id": req.accepted_by_id},
    }
    try:
        result = apply_memo_review_decision(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {
        "deal_id": deal_id,
        "accepted": result["memo_status"] == "accepted",
        "memo_status": result["memo_status"],
        "memo": result["memo"],
        "current_stage": result["current_stage"],
        "accepted_by_id": result["accepted_by_id"],
    }


@router.get("/deals/{deal_id}/memo")
def get_memo(deal_id: str):
    _get_deal_or_404(deal_id)
    memo_row = _latest_memo(deal_id)
    if memo_row is None:
        raise HTTPException(status_code=404, detail="no memo drafted for this deal")
    return memo_row
