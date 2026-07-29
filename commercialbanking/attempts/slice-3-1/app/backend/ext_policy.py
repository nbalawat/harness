"""memo-policy-compliance slice, part 2: versioned lending policy, portfolio
exposure aggregation, and policy-compliance exceptions.

Implements the policy-compliance portion of the approved `deal-underwriting`
workflow (workflows/workflows.json): aggregate_exposure -> policy_review
(agent) -> persist_exceptions -> [review_exceptions: human] ->
apply_exception_dispositions -> check_exceptions_cleared. The three
deterministic nodes are registered as real workflow_engine handlers under
the exact names the workflow definition calls out.

The REST surface below (/deals/{id}/policy-review/run,
/deals/{id}/policy-review/accept, /policy-rules) calls those SAME handler
functions directly with a hand-built context, matching every prior slice's
pattern: the acceptance contract needs distinct propose / human-dispositions
steps rather than the one-shot chain the generic engine would run.

Composition contract:
  * storage -> db.store only (policy_rules, portfolio_exposures,
               policy_exceptions, audit_trail)
  * policy  -> lending policy (concentration limits, prohibited industries,
               loan-to-value caps) is configurable, versioned DATA in
               policy_rules (REQ-022) — a documented default rule set ships
               here since no bank policy document was supplied; nothing
               about the rule thresholds is hard-coded into a decision path,
               only the lookup/evaluation logic is code.
  * exposure -> concentration evaluation aggregates requested_amount across
               every ACTIVE deal in the portfolio, not just the deal under
               review (REQ-023), snapshotted into portfolio_exposures.
  * agent    -> agent_runtime.respond() carries the Policy Compliance
               Agent's narrative only. Every raised exception's policy rule
               id and violation description is derived deterministically by
               evaluating the deal + portfolio exposure against the stored
               policy_rules rows — never invented or paraphrased by the
               model — matching the provenance pattern used by every prior
               slice.
  * lifecycle -> exceptions are persisted "open" and stay disposable
               (waived/resolved) by a named human (REQ-024); the deal only
               advances past policy_compliance_review once every open
               exception has been dispositioned.
  * routes   -> mounted outside /api/ so the /api/{table} catch-all in
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
from statemachine import IllegalTransition

router = APIRouter()

POLICY_VERSION = "v1"
POLICY_EFFECTIVE_DATE = "2026-01-01"

# Documented default lending policy rule set (REQ-022) — configurable,
# versioned data. No bank policy document was supplied for this build, so
# these are the bank's published starting thresholds; edit the rows, not the
# evaluation code, to change them.
DEFAULT_POLICY_RULES = [
    {
        "rule_type": "concentration",
        "rule_name": "Industry concentration limit",
        "description": (
            "Caps any single industry's share of total active portfolio exposure to control "
            "concentration risk. Evaluated against the aggregated exposure of every active deal, "
            "not just the deal under review."
        ),
        "rule_definition": {
            "dimension": "industry",
            "default_cap_percentage": 20.0,
            "caps_by_industry": {
                "manufacturing": 30.0,
                "wholesale": 25.0,
                "retail": 25.0,
                "healthcare": 25.0,
                "real_estate": 35.0,
                "hospitality": 20.0,
            },
        },
        "version": POLICY_VERSION,
        "effective_date": POLICY_EFFECTIVE_DATE,
    },
    {
        "rule_type": "prohibited_industry",
        "rule_name": "Prohibited industries",
        "description": "Borrower industries the bank will not underwrite commercial credit for, under any exposure.",
        "rule_definition": {
            "prohibited_industries": [
                "gambling",
                "cannabis",
                "firearms",
                "adult_entertainment",
                "cryptocurrency_exchange",
                "payday_lending",
            ]
        },
        "version": POLICY_VERSION,
        "effective_date": POLICY_EFFECTIVE_DATE,
    },
    {
        "rule_type": "loan_to_value",
        "rule_name": "Loan-to-value caps",
        "description": "Maximum loan-to-value percentage permitted, by collateral type.",
        "rule_definition": {
            "default_cap_percentage": 70.0,
            "caps_by_collateral_type": {
                "owner_occupied_real_estate": 80.0,
                "investment_real_estate": 75.0,
                "equipment": 75.0,
                "general_commercial": 70.0,
            },
        },
        "version": POLICY_VERSION,
        "effective_date": POLICY_EFFECTIVE_DATE,
    },
]


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _ensure_policy_rules_seeded():
    existing_types = {r["rule_type"] for r in store.list("policy_rules")}
    now = _now_iso()
    for rule in DEFAULT_POLICY_RULES:
        if rule["rule_type"] not in existing_types:
            store.insert("policy_rules", {**rule, "created_at": now})


_ensure_policy_rules_seeded()


def _get_rule(rule_type):
    rows = [r for r in store.list("policy_rules") if r["rule_type"] == rule_type]
    return rows[-1] if rows else None


def applicable_ltv_rule(collateral_description):
    """Shared with ext_memo.py: the loan_to_value policy rule the memo cites (LTV is known
    at memo-drafting time, unlike concentration which needs the portfolio-wide exposure
    aggregation this module computes)."""
    return _get_rule("loan_to_value")


def _ltv_cap_for(collateral_description, rule):
    text = (collateral_description or "").lower()
    caps = (rule.get("rule_definition") or {}).get("caps_by_collateral_type", {})
    if "owner-occupied" in text or "owner occupied" in text:
        key = "owner_occupied_real_estate"
    elif "real estate" in text or "commercial property" in text:
        key = "investment_real_estate"
    elif "equipment" in text:
        key = "equipment"
    else:
        key = None
    if key and key in caps:
        return caps[key], key
    return (rule.get("rule_definition") or {}).get("default_cap_percentage"), "default"


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


# --------------------------------------------------------------------------
# workflow handlers — deal-underwriting (this slice's portion)
# --------------------------------------------------------------------------

def aggregate_portfolio_exposure(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id") or (context.get("apply_memo_decision") or {}).get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to aggregate exposure for")

    active_deals = [d for d in store.list("deals") if d.get("status") == "active"]
    totals = {}
    for d in active_deals:
        industry = (d.get("industry") or "unspecified").lower()
        totals[industry] = totals.get(industry, 0) + (d.get("requested_amount") or 0)
    total_portfolio_exposure = sum(totals.values())

    now = _now_iso()
    dimension_rows = []
    for industry, amount in totals.items():
        pct = (amount / total_portfolio_exposure * 100.0) if total_portfolio_exposure else 0.0
        stored = store.insert(
            "portfolio_exposures",
            {
                "deal_id": deal_id,
                "exposure_dimension": "industry",
                "dimension_value": industry,
                "exposure_amount": amount,
                "computed_at": now,
            },
        )
        dimension_rows.append(
            {"id": stored["id"], "dimension_value": industry, "exposure_amount": amount, "pct_of_portfolio": pct}
        )

    exposure_by_dimension = {"industry": dimension_rows}
    deal_exposure_amount = deal.get("requested_amount") or 0
    _audit(
        deal_id,
        "exposure.aggregated",
        "exposure-engine",
        "system",
        after={"total_portfolio_exposure": total_portfolio_exposure, "dimensions": dimension_rows},
        description=f"Aggregated portfolio exposure across {len(active_deals)} active deal(s) by industry.",
    )
    return {
        "deal_id": deal_id,
        "deal_exposure_amount": deal_exposure_amount,
        "exposure_by_dimension": exposure_by_dimension,
        "total_portfolio_exposure": total_portfolio_exposure,
        "computed_at": now,
    }


def _evaluate_breaches(deal, exposure_result):
    breaches = []
    rules_evaluated = []

    prohibited_rule = _get_rule("prohibited_industry")
    if prohibited_rule:
        rules_evaluated.append(prohibited_rule["id"])
        prohibited_list = [i.lower() for i in (prohibited_rule.get("rule_definition") or {}).get("prohibited_industries", [])]
        industry = (deal.get("industry") or "").lower()
        if industry in prohibited_list:
            breaches.append(
                {
                    "policy_rule_id": prohibited_rule["id"],
                    "violation_description": (
                        f"Borrower industry '{deal.get('industry')}' is on the prohibited industries list "
                        f"(policy '{prohibited_rule['rule_name']}' v{prohibited_rule['version']})."
                    ),
                }
            )

    ltv_rule = _get_rule("loan_to_value")
    if ltv_rule:
        rules_evaluated.append(ltv_rule["id"])
        cap, basis = _ltv_cap_for(deal.get("collateral_description"), ltv_rule)
        ltv = deal.get("ltv_percentage")
        if cap is not None and ltv is not None and ltv > cap:
            breaches.append(
                {
                    "policy_rule_id": ltv_rule["id"],
                    "violation_description": (
                        f"Deal LTV of {ltv}% exceeds the {cap}% cap for '{basis}' collateral "
                        f"(policy '{ltv_rule['rule_name']}' v{ltv_rule['version']})."
                    ),
                }
            )

    concentration_rule = _get_rule("concentration")
    if concentration_rule:
        rules_evaluated.append(concentration_rule["id"])
        industry = (deal.get("industry") or "unspecified").lower()
        caps_by_industry = (concentration_rule.get("rule_definition") or {}).get("caps_by_industry", {})
        cap = caps_by_industry.get(industry, (concentration_rule.get("rule_definition") or {}).get("default_cap_percentage"))
        dimension_rows = (exposure_result.get("exposure_by_dimension") or {}).get("industry", [])
        row = next((r for r in dimension_rows if r["dimension_value"] == industry), None)
        pct = row["pct_of_portfolio"] if row else 0.0
        if cap is not None and pct > cap:
            breaches.append(
                {
                    "policy_rule_id": concentration_rule["id"],
                    "violation_description": (
                        f"Industry '{industry}' concentration is {pct:.1f}% of active portfolio exposure, "
                        f"exceeding the {cap}% cap (policy '{concentration_rule['rule_name']}' v{concentration_rule['version']})."
                    ),
                }
            )

    return breaches, rules_evaluated


def persist_policy_exceptions(context):
    record = context.get("record_intake") or {}
    exposure = context.get("aggregate_exposure") or {}
    deal_id = record.get("deal_id") or exposure.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to run policy review for")

    breaches, rules_evaluated = _evaluate_breaches(deal, exposure)
    now = _now_iso()
    exception_ids = []
    exceptions = []
    for breach in breaches:
        row = store.insert(
            "policy_exceptions",
            {
                "deal_id": deal_id,
                "policy_rule_id": breach["policy_rule_id"],
                "violation_description": breach["violation_description"],
                "exception_status": "open",
                "waived_by_id": None,
                "waived_at": None,
                "waiver_reason": None,
                "resolved_at": None,
                "created_at": now,
            },
        )
        exception_ids.append(row["id"])
        exceptions.append(row)

    agent_reply = (context.get("policy_review") or {}).get("reply", "")
    _audit(
        deal_id,
        "policy_review.completed",
        "policy-compliance-agent",
        "agent",
        after={"exception_ids": exception_ids, "rules_evaluated": rules_evaluated},
        description=(
            f"Policy compliance review evaluated {len(rules_evaluated)} rule(s) and raised "
            f"{len(exception_ids)} exception(s). Agent notes: {agent_reply}"
        ),
    )
    return {
        "deal_id": deal_id,
        "exception_ids": exception_ids,
        "exceptions": exceptions,
        "open_exception_count": len(exception_ids),
        "rules_evaluated": rules_evaluated,
        "policy_version": POLICY_VERSION,
    }


def apply_exception_dispositions(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to disposition exceptions for")

    decision_details = context.get("decision_details") or {}
    decision = (decision_details.get("decision") or "accept").lower()
    dispositioned_by_id = decision_details.get("dispositioned_by_id")
    dispositions = decision_details.get("dispositions") or []
    disp_map = {d["exception_id"]: d for d in dispositions if "exception_id" in d}

    now = _now_iso()
    open_rows = [r for r in store.list("policy_exceptions") if r["deal_id"] == deal_id and r["exception_status"] == "open"]
    if not open_rows:
        raise workflow_engine.WorkflowError(f"no open policy exceptions for deal '{deal_id}'")

    if decision == "accept":
        for row in open_rows:
            disp = disp_map.get(row["id"])
            if disp is None:
                raise workflow_engine.WorkflowError(f"missing disposition for open exception {row['id']}")
            new_status = disp.get("disposition") or "waived"
            if new_status not in ("waived", "resolved"):
                raise workflow_engine.WorkflowError(f"invalid disposition '{new_status}' for exception {row['id']}")
            row["exception_status"] = new_status
            row["waived_by_id"] = dispositioned_by_id
            row["waived_at"] = now
            row["waiver_reason"] = disp.get("waiver_reason") or ""
            if new_status == "resolved":
                row["resolved_at"] = now

    remaining_open = len([r for r in store.list("policy_exceptions") if r["deal_id"] == deal_id and r["exception_status"] == "open"])
    if decision != "accept":
        disposition_status = "returned_for_rework"
    elif remaining_open == 0:
        disposition_status = "cleared"
    else:
        disposition_status = "pending"

    _audit(
        deal_id,
        f"policy_exceptions.{disposition_status}",
        dispositioned_by_id,
        "human",
        before={"open_count": len(open_rows)},
        after={"open_exception_count": remaining_open},
        description=f"Policy exceptions dispositioned by {dispositioned_by_id}: {disposition_status}.",
    )

    if disposition_status == "cleared":
        previous_stage = deal["current_stage"]
        try:
            new_stage = stage_machine.advance(previous_stage, "clear_exceptions")
        except IllegalTransition as e:
            raise workflow_engine.WorkflowError(str(e))
        deal["current_stage"] = new_stage
        deal["last_activity_at"] = now
        _audit(
            deal_id,
            "deal.stage_advanced",
            dispositioned_by_id,
            "human",
            before={"current_stage": previous_stage},
            after={"current_stage": new_stage},
            description=f"Deal advanced to '{new_stage}' after every policy exception was dispositioned.",
        )
    elif disposition_status == "returned_for_rework":
        previous_stage = deal["current_stage"]
        try:
            new_stage = stage_machine.advance(previous_stage, "return_for_rework")
        except IllegalTransition as e:
            raise workflow_engine.WorkflowError(str(e))
        deal["current_stage"] = new_stage
        deal["last_activity_at"] = now

    return {
        "deal_id": deal_id,
        "open_exception_count": remaining_open,
        "disposition_status": disposition_status,
        "dispositioned_by_id": dispositioned_by_id,
        "dispositioned_at": now,
        "current_stage": deal["current_stage"],
    }


for _name, _fn in [
    ("aggregate_portfolio_exposure", aggregate_portfolio_exposure),
    ("persist_policy_exceptions", persist_policy_exceptions),
    ("apply_exception_dispositions", apply_exception_dispositions),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class ExceptionDisposition(BaseModel):
    exception_id: int
    disposition: str = "waived"  # "waived" | "resolved"
    waiver_reason: str = ""


class PolicyReviewAcceptRequest(BaseModel):
    decision: str = "accept"
    dispositioned_by_id: str
    dispositions: list[ExceptionDisposition] = []


@router.get("/policy-rules")
def list_policy_rules():
    rows = store.list("policy_rules")
    return {
        "version": POLICY_VERSION,
        "rules": rows,
        "concentration": [r for r in rows if r["rule_type"] == "concentration"],
        "prohibited_industries": [r for r in rows if r["rule_type"] == "prohibited_industry"],
        "loan_to_value": [r for r in rows if r["rule_type"] == "loan_to_value"],
    }


@router.post("/deals/{deal_id}/policy-review/run")
def policy_review_run(deal_id: str):
    deal = _get_deal_or_404(deal_id)
    accepted_memos = [r for r in store.list("credit_memo_drafts") if r["deal_id"] == deal_id and r["draft_status"] == "accepted"]
    if not accepted_memos:
        raise HTTPException(status_code=400, detail="the credit memo must be accepted before running the policy review")

    context = {"record_intake": {"deal_id": deal_id}}
    try:
        exposure_result = aggregate_portfolio_exposure(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    context["aggregate_exposure"] = exposure_result

    prompt = (
        f"You are the policy compliance agent for deal {deal_id}. Review the accepted memo "
        f"{accepted_memos[-1]['id']} against the active versioned lending policy (version {POLICY_VERSION}), "
        f"covering at minimum concentration limits (portfolio exposure by industry: "
        f"{exposure_result['exposure_by_dimension']}; this deal's exposure {exposure_result['deal_exposure_amount']}), "
        f"prohibited industries (borrower industry: {deal.get('industry')}), and loan-to-value caps (deal LTV: "
        f"{deal.get('ltv_percentage')}%). For each violation raise a written exception naming the policy rule id "
        "and describing precisely how the deal breaches it. Do not waive, resolve, or approve anything, and do "
        "not alter the memo. Return exceptions only; a human dispositions them."
    )
    context["policy_review"] = {"reply": agent_runtime.respond(prompt, agent_name="Policy Compliance Agent")}
    try:
        result = persist_policy_exceptions(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "deal_id": deal_id,
        "exceptions": result["exceptions"],
        "exception_ids": result["exception_ids"],
        "open_exception_count": result["open_exception_count"],
        "exposure_by_dimension": exposure_result["exposure_by_dimension"],
        "deal_exposure_amount": exposure_result["deal_exposure_amount"],
        "rules_evaluated": result["rules_evaluated"],
        "policy_version": result["policy_version"],
    }


@router.post("/deals/{deal_id}/policy-review/accept")
def policy_review_accept(deal_id: str, req: PolicyReviewAcceptRequest):
    _get_deal_or_404(deal_id)
    context = {
        "record_intake": {"deal_id": deal_id},
        "decision_details": {
            "decision": req.decision,
            "dispositioned_by_id": req.dispositioned_by_id,
            "dispositions": [d.model_dump() for d in req.dispositions],
        },
    }
    try:
        result = apply_exception_dispositions(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "deal_id": deal_id,
        "cleared": result["disposition_status"] == "cleared",
        "disposition_status": result["disposition_status"],
        "open_exception_count": result["open_exception_count"],
        "dispositioned_by_id": result["dispositioned_by_id"],
        "current_stage": result["current_stage"],
    }


@router.get("/deals/{deal_id}/policy-exceptions")
def list_deal_exceptions(deal_id: str):
    _get_deal_or_404(deal_id)
    return [r for r in store.list("policy_exceptions") if r["deal_id"] == deal_id]
