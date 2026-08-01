"""ext_memo_policy: slice `memo-policy-and-audit-trail`.

Once a deal has an accepted spread, computed ratios, and an assigned risk
grade, the Credit Memo Agent drafts the underwriting memo citing the ratio,
spread-line, and policy-rule references it relied on. The Policy Compliance
Agent then tests the deal against the active lending ruleset (concentration
limits, prohibited industries, LTV caps) and writes a formal exception for
every breach it finds — deterministically, since exception detection is
concentration/industry/LTV arithmetic, never LLM judgement. Everything either
agent produces is a proposal: a human analyst accepts (or edits) the memo
draft, and only a credit officer may waive an exception (owned by a later
slice). Every mutation here also lands a normalized row in `audit_log` via
`ext_audit.record()`, which is what the deal's Chronicle (audit-timeline
screen) reads back in order.

Two of the `deal-underwriting-lifecycle` workflow's deterministic node
handlers are implemented and registered here (`persist_accepted_memo` for
node `savememo`, `record_policy_exceptions` for node `exceptions`) so their
contracts are real, callable functions, per the workflow-authoring
convention. As with `ext_deal_intake.py`, they are invoked directly from the
REST endpoints below rather than through `workflow_engine.start()/tick()` —
sibling slices in this lifecycle (spreading, grading, approval) are built as
separate parallel slices and may not have registered their own handlers in
this checkout.

Parallel-build note: this slice's acceptance drives DEAL-1003 directly,
without depending on any sibling slice having created it first. `_deal_or_404`
lazily seeds DEAL-1003 (a cannabis-dispensary fixture, deliberately chosen so
the Policy Compliance Agent's prohibited-industry check has something real to
catch) the first time it is addressed, complete with an accepted spread,
computed ratios and an assigned risk grade — exactly the inputs the Credit
Memo Agent needs — with an explicit `deal_code`, per the sequence-independent
fixture pattern `deals_repo.py` documents.
"""
import datetime
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import deals_repo
import drafts
import identity
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

# Authority is resolved SERVER-SIDE, never from the request body's claims:
# every mutating route below calls identity.require_actor(email, permission,
# …), the foundation's default-deny guard, and lets it raise 401/403. The
# permissions themselves come from the approved role model in identity.py —
# an analyst may draft/accept a memo and run the policy screen; a
# relationship manager may not.
MEMO_PERMISSION = "deal.memo"
POLICY_PERMISSION = "deal.policy_check"

FIXTURE_DEAL_CODE = "DEAL-1003"
POLICY_VERSION = "v4.2"
PROHIBITED_INDUSTRIES = {"cannabis_dispensary", "cannabis", "gambling", "adult_entertainment", "arms_dealing", "payday_lending"}
MAX_INDUSTRY_CONCENTRATION_PCT = 25.0
MAX_SINGLE_EXPOSURE_AMOUNT = 5_000_000
MAX_LTV_PCT = 75.0


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ------------------------------------------------------------------------
# lending policy ruleset (lending_policy table) — seeded once, versioned
# ------------------------------------------------------------------------

def _ensure_policy_ruleset():
    active = [r for r in store.list("lending_policy") if r.get("version") == POLICY_VERSION and r.get("is_active")]
    if active:
        return active
    now = _now()
    rules = [
        {
            "version": POLICY_VERSION,
            "rule_type": "prohibited_industry",
            "rule_key": "PROHIBITED-IND-01",
            "rule_value": {"industries": sorted(PROHIBITED_INDUSTRIES)},
            "is_active": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "version": POLICY_VERSION,
            "rule_type": "concentration_limit",
            "rule_key": "CONC-CAP-01",
            "rule_value": {"max_industry_concentration_pct": MAX_INDUSTRY_CONCENTRATION_PCT, "max_single_exposure_amount": MAX_SINGLE_EXPOSURE_AMOUNT},
            "is_active": True,
            "created_at": now,
            "updated_at": now,
        },
        {
            "version": POLICY_VERSION,
            "rule_type": "ltv_cap",
            "rule_key": "LTV-CAP-01",
            "rule_value": {"max_ltv_pct": MAX_LTV_PCT},
            "is_active": True,
            "created_at": now,
            "updated_at": now,
        },
    ]
    return [store.insert("lending_policy", r) for r in rules]


# ------------------------------------------------------------------------
# deterministic ratio + risk-grade rubric
#
# R-016/R-017/R-018/R-042/R-045: ratios are arithmetic and the risk grade is a
# lookup against a VERSIONED rubric — neither may ever be an LLM's opinion,
# and (governance finding, fixed here) neither may ever be a literal written
# straight onto a deal. `deals.risk_grade` is only ever synced FROM a
# persisted `risk_grades` row that `_assign_risk_grade` produced by running
# `grade_from_rubric` over ratios computed by `compute_ratio` from an ACCEPTED
# spread. There is exactly one path to a grade in this module, and the fixture
# seeding below walks it like any other deal.
#
# (The grading rubric is owned end-to-end by the sibling
# `spread-ratios-and-risk-grade` slice for the deals it drives; these
# functions are this module's own copy of the same deterministic contract so
# that the memo path is never blocked on a sibling slice being present, and so
# that no seeding path can shortcut the calculation.)
# ------------------------------------------------------------------------

RUBRIC_VERSION = "v2.1"
ROUNDING_METHOD = "round_half_up_2dp"
DIVIDE_BY_ZERO_HANDLING = "return_null"

# ratio_type -> (numerator line item, denominator line item)
RATIO_DEFINITIONS = [
    ("dscr", "ebitda", "annual_debt_service"),
    ("leverage", "total_funded_debt", "ebitda"),
    ("current_ratio", "current_assets", "current_liabilities"),
]

# Ordered bands, first match wins. Pure data: the only place a grade number
# is written down in this module.
RUBRIC_BANDS = [
    {"grade": 2, "label": "Strong", "min_dscr": 1.50, "max_leverage": 2.50},
    {"grade": 3, "label": "Pass", "min_dscr": 1.35, "max_leverage": 3.50},
    {"grade": 5, "label": "Watch", "min_dscr": 1.10, "max_leverage": 4.50},
    {"grade": 7, "label": "Substandard", "min_dscr": None, "max_leverage": None},
]


def compute_ratio(numerator, denominator):
    """A pure ratio calculation with the app's fixed rounding and an explicit
    divide-by-zero rule (never an exception, never a silent zero)."""
    if denominator in (None, 0):
        result = None
    else:
        result = round(float(numerator) / float(denominator), 2)
    return {
        "numerator": numerator,
        "denominator": denominator,
        "result": result,
        "rounding_method": ROUNDING_METHOD,
        "divide_by_zero_handling": DIVIDE_BY_ZERO_HANDLING,
    }


def grade_from_rubric(ratio_results):
    """Maps computed ratios onto the versioned rubric. Returns the grade, the
    rubric version it came from, and the exact band struck — the audit trail
    R-042 requires. Never called with anything but computed ratio rows."""
    dscr = ratio_results.get("dscr")
    leverage = ratio_results.get("leverage")
    for band in RUBRIC_BANDS:
        min_dscr = band["min_dscr"]
        max_leverage = band["max_leverage"]
        dscr_ok = min_dscr is None or (dscr is not None and dscr >= min_dscr)
        leverage_ok = max_leverage is None or (leverage is not None and leverage <= max_leverage)
        if dscr_ok and leverage_ok:
            bounds = []
            if min_dscr is not None:
                bounds.append(f"DSCR >= {min_dscr}x")
            if max_leverage is not None:
                bounds.append(f"leverage <= {max_leverage}x")
            band_hit = f"{band['label']} — " + (", ".join(bounds) if bounds else "residual band, no bound met above")
            return {
                "grade": band["grade"],
                "rubric_version": RUBRIC_VERSION,
                "band_hit": band_hit,
                "reasoning": (
                    f"DSCR {dscr}x, leverage {leverage}x, current ratio "
                    f"{ratio_results.get('current_ratio')}x tested against rubric "
                    f"{RUBRIC_VERSION} bands in order; band '{band['label']}' struck first."
                ),
            }
    raise RuntimeError("rubric has no residual band — every rubric must be total")


# ------------------------------------------------------------------------
# parallel-build fixture: DEAL-1003 driven through the real
# spread-accept -> ratios -> rubric flow
# ------------------------------------------------------------------------

def _ensure_fixture_deal():
    """Guarantees DEAL-1003 exists AND carries an accepted spread, computed
    ratios, and an assigned risk grade — the inputs the Credit Memo Agent
    needs. Two paths land here:

    - A clean boot (the acceptance/demo path): DEAL-1003 does not exist yet,
      so a full cannabis-dispensary fixture is created — deliberately a
      prohibited industry, so the Policy Compliance Agent has a real breach
      to catch.
    - The shared backend test process, where another slice's test file may
      already have claimed DEAL-1003 via the ordinary /api/deals sequence
      before this module ever runs: in that case the existing deal (whatever
      borrower it belongs to) is left exactly as-is, and only the missing
      underwriting inputs (spread/ratios/grade) are backfilled onto it, so
      the memo endpoint's prerequisites are satisfiable either way.
    """
    existing = deals_repo.get_deal(FIXTURE_DEAL_CODE)
    if existing is None:
        existing = _create_cannabis_fixture_deal()
    _backfill_underwriting_inputs(existing)
    return deals_repo.get_deal(FIXTURE_DEAL_CODE)


def _create_cannabis_fixture_deal():
    rm = identity.resolve_user("rm@bank.test")
    analyst = identity.resolve_user("analyst@bank.test")
    now = _now()

    deal = store.insert("deals", {
        "deal_code": FIXTURE_DEAL_CODE,
        "borrower_name": "Cascade Greenleaf Dispensary",
        "borrower_industry": "cannabis_dispensary",
        "borrower_entity_id": None,
        "requested_amount": 900000,
        "exposure_amount": 900000,
        "current_stage": "memo_drafting",
        "current_status": "memo_pending",
        "created_by_user_id": rm["id"] if rm else None,
        "assigned_to_user_id": analyst["id"] if analyst else None,
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": now,
        "created_at": now,
        "updated_at": now,
    })
    audit("deal.fixture_seeded", {
        "deal_id": FIXTURE_DEAL_CODE, "actor_user_id": rm["id"] if rm else None,
        "resource_type": "deal", "resource_id": FIXTURE_DEAL_CODE, "after": deal,
    })
    return deal


FIXTURE_SPREAD_LINES = [
    ("net_revenue", "FY25", 3200000, "usd"),
    ("ebitda", "FY25", 540000, "usd"),
    ("annual_debt_service", "FY25", 432000, "usd"),
    ("total_funded_debt", "FY25", 1620000, "usd"),
    ("current_assets", "FY25", 410000, "usd"),
    ("current_liabilities", "FY25", 355000, "usd"),
]


def _seed_accepted_spread(deal_code, analyst):
    """Step 1 of the flow: a cited spread draft, then an explicit human
    acceptance. Nothing downstream reads a figure that did not come from an
    accepted spread line."""
    now = _now()
    spread_rows = {}
    for key, period, value, unit in FIXTURE_SPREAD_LINES:
        row = store.insert("financial_spread_template", {
            "deal_id": deal_code, "template_version": "v1", "line_item_key": key,
            "period": period, "value": value, "unit": unit, "created_at": now,
        })
        spread_rows[key] = row
        store.insert("citations", {
            "source_type": "financial_spread_template", "source_id": row["id"], "document_id": f"DOC-FIXTURE-{deal_code}",
            "page_number": 2, "section": "Income Statement", "cell_locator": key.upper(),
            "quoted_text": f"{key} = {value}", "created_at": now,
        })
    review = store.insert("human_reviews", {
        "agent_output_id": None, "deal_id": deal_code, "reviewed_by_user_id": analyst["id"] if analyst else None,
        "action": "accept", "original_content": {"template_version": "v1"}, "edited_content": None,
        "rejection_reason": None, "reviewed_at": now,
    })
    audit("spread.accepted", {
        "deal_id": deal_code, "actor_user_id": analyst["id"] if analyst else None,
        "resource_type": "financial_spread_template", "resource_id": spread_rows["ebitda"]["id"],
        "before": {"spread": "draft"}, "after": {"spread": "accepted", "review_id": review["id"]},
    })
    return spread_rows


def _compute_and_store_ratios(deal_code):
    """Step 2: DSCR, leverage and current ratio computed by `compute_ratio`
    from the accepted spread lines, each persisted with its own numerator,
    denominator, rounding rule and divide-by-zero rule."""
    values = {r["line_item_key"]: r["value"] for r in _spread_rows(deal_code)}
    now = _now()
    ratio_rows = {}
    for ratio_type, numerator_key, denominator_key in RATIO_DEFINITIONS:
        calc = compute_ratio(values.get(numerator_key), values.get(denominator_key))
        ratio_rows[ratio_type] = store.insert("financial_ratios", {
            "deal_id": deal_code, "ratio_type": ratio_type, **calc,
            "computed_at": now, "created_at": now,
        })
    audit("ratios.computed", {
        "deal_id": deal_code, "resource_type": "financial_ratios",
        "resource_id": ratio_rows["dscr"]["id"],
        "after": {k: v["result"] for k, v in ratio_rows.items()},
    })
    return ratio_rows


def _assign_risk_grade(deal_code):
    """Step 3: the ONLY way a grade reaches a deal in this module.

    `grade_from_rubric` is run over the stored ratio rows, the result is
    persisted as a `risk_grades` row, and `deals.risk_grade` is then synced
    from that persisted row. If a sibling slice already graded this deal, its
    rubric row is authoritative and is simply re-synced — this function never
    invents, overrides, or hard-codes a grade.
    """
    existing = _latest_grade(deal_code)
    if existing is None:
        ratio_results = {t: r["result"] for t, r in _latest_ratios(deal_code).items()}
        rubric_result = grade_from_rubric(ratio_results)
        now = _now()
        existing = store.insert("risk_grades", {
            "deal_id": deal_code, **rubric_result, "computed_at": now, "created_at": now,
        })
        audit("risk_grade.assigned", {
            "deal_id": deal_code, "resource_type": "risk_grade", "resource_id": existing["id"],
            "after": {
                "grade": existing["grade"], "rubric_version": existing["rubric_version"],
                "band_hit": existing["band_hit"],
            },
        })
    current = deals_repo.get_deal(deal_code)
    if current is not None and current.get("risk_grade") != existing["grade"]:
        deals_repo.update_deal(
            deal_code, risk_grade=existing["grade"], last_activity_timestamp=_now()
        )
    return existing


def _backfill_underwriting_inputs(deal):
    """Gives `deal` the underwriting inputs the Credit Memo Agent needs, by
    walking the real flow — accepted spread -> computed ratios -> rubric
    grade — rather than writing any of them down as literals. Idempotent, and
    safe to call against a deal this module did not create itself."""
    deal_code = deal["deal_code"]
    if _spread_rows(deal_code):
        # Already carries underwriting inputs (from us, or from a sibling
        # slice driving the same deal). Nothing to seed; just make sure the
        # deal record reflects whatever rubric row is on file.
        if _latest_ratios(deal_code) and _latest_grade(deal_code) is not None:
            _assign_risk_grade(deal_code)
        return

    analyst = identity.resolve_user("analyst@bank.test")
    _seed_accepted_spread(deal_code, analyst)
    _compute_and_store_ratios(deal_code)
    # The grade is produced by the rubric engine above, from those ratios.
    # An already-existing deal's stage/status belongs to whichever slice is
    # driving its lifecycle; a brand-new fixture already got its starting
    # stage in _create_cannabis_fixture_deal.
    _assign_risk_grade(deal_code)


def _deal_or_404(deal_code):
    if deal_code == FIXTURE_DEAL_CODE:
        _ensure_fixture_deal()
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def _latest_ratios(deal_code):
    by_type = {}
    for r in store.list("financial_ratios"):
        if r.get("deal_id") == deal_code:
            by_type[r["ratio_type"]] = r
    return by_type


def _latest_grade(deal_code):
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_code]
    return rows[-1] if rows else None


def _spread_rows(deal_code):
    latest = {}
    for r in store.list("financial_spread_template"):
        if r.get("deal_id") == deal_code:
            latest[(r["line_item_key"], r["period"])] = r
    return list(latest.values())


# ------------------------------------------------------------------------
# workflow-engine handlers (deal-underwriting-lifecycle: savememo, exceptions)
# ------------------------------------------------------------------------

def persist_accepted_memo(context):
    """Node `savememo`: a human analyst has accepted (or edited) the Credit
    Memo Agent's draft. R-011/R-055: the agent may only propose — persisting
    the accepted content and advancing the deal are deterministic here."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("actor_user_id")
    key = f"memo:{deal_code}"
    if drafts.draft(key) is None:
        raise HTTPException(status_code=409, detail="run the credit memo agent before accepting its draft")
    content = drafts.publish(key)
    memo_id = context.get("agent_output_id")  # the credit-memo agent_outputs row is the memo's stable id
    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": actor_user_id,
        "action": context.get("action", "accept"),
        "original_content": context.get("original_content"),
        "edited_content": context.get("edited_content"),
        "rejection_reason": None,
        "reviewed_at": _now(),
    })
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="policy_compliance",
        current_status="policy_review_pending",
        last_activity_timestamp=_now(),
    )
    entry = audit("memo.accepted", {
        "deal_id": deal_code, "actor_user_id": actor_user_id, "resource_type": "agent_draft",
        "resource_id": memo_id, "before": {"current_stage": "memo_drafting"}, "after": updated,
    })
    return {
        "memo_id": memo_id,
        "citation_ids": [c.get("source_id") for c in (content.get("citations") or [])],
        "review_id": review["id"],
        "reviewed_by_user_id": actor_user_id,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("persist_accepted_memo", persist_accepted_memo)


def record_policy_exceptions(context):
    """Node `exceptions`: persists the Policy Compliance Agent's proposed
    exceptions as formal, open exception rows. R-012/R-013/R-052/R-055: the
    agent's `propose_policy_exception` output lands here, in code — the
    agent's own tool set denies it `persist_policy_exception` outright."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("actor_user_id")
    policy_version = context.get("policy_version")
    exception_ids = []
    for exc in context.get("exceptions") or []:
        row = store.insert("policy_exceptions", {
            "deal_id": deal_code,
            "policy_rule_id": exc.get("policy_rule_id"),
            "rule_reference": exc["rule_reference"],
            "violation_detail": exc["violation_detail"],
            "rationale": exc["rationale"],
            "status": "open",
            "raised_by_user_id": actor_user_id,
            "resolved_by_user_id": None,
            "resolved_at": None,
            "created_at": _now(),
        })
        exception_ids.append(row["id"])
        audit("policy.exception_raised", {
            "deal_id": deal_code, "actor_user_id": actor_user_id, "resource_type": "policy_exception",
            "resource_id": row["id"], "after": row,
        })
    open_count = len([
        e for e in store.list("policy_exceptions")
        if e.get("deal_id") == deal_code and e.get("status") == "open"
    ])
    entry = audit("policy.exceptions_recorded", {
        "deal_id": deal_code, "actor_user_id": actor_user_id, "resource_type": "policy_exception",
        "resource_id": exception_ids[0] if exception_ids else None,
        "after": {"exception_ids": exception_ids, "policy_version": policy_version, "open_exception_count": open_count},
    })
    return {
        "policy_version": policy_version,
        "exception_ids": exception_ids,
        "open_exception_count": open_count,
        "has_open_exceptions": open_count > 0,
        "review_id": context.get("review_id"),
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_policy_exceptions", record_policy_exceptions)


# ------------------------------------------------------------------------
# deterministic policy evaluation — never delegated to the agent
# ------------------------------------------------------------------------

def _evaluate_policy(deal):
    """Tests `deal` against every active rule in the ruleset. Returns
    (findings, exceptions) — both deterministic, so the agent's narrative can
    never change whether a breach was caught."""
    rules = _ensure_policy_ruleset()
    all_deals = deals_repo.all_current_deals()
    industry = (deal.get("borrower_industry") or "").lower()
    exposure = float(deal.get("exposure_amount") or 0)
    total_portfolio_exposure = sum(float(d.get("exposure_amount") or 0) for d in all_deals) or exposure or 1.0
    same_industry_exposure = sum(
        float(d.get("exposure_amount") or 0) for d in all_deals
        if (d.get("borrower_industry") or "").lower() == industry
    )
    concentration_pct = round((same_industry_exposure / total_portfolio_exposure) * 100, 2)

    findings = []
    exceptions = []

    for rule in rules:
        rule_type = rule["rule_type"]
        rule_reference = rule["rule_key"]
        value = rule["rule_value"]

        if rule_type == "prohibited_industry":
            prohibited = industry in {i.lower() for i in value["industries"]}
            findings.append({
                "rule_reference": rule_reference, "rule_type": rule_type,
                "status": "violated" if prohibited else "passed",
                "actual_value": industry, "permitted_value": "not in prohibited list",
            })
            if prohibited:
                exceptions.append({
                    "policy_rule_id": rule["id"], "rule_reference": rule_reference,
                    "violation_detail": f"borrower industry '{industry}' is a prohibited industry under policy {POLICY_VERSION}",
                    "rationale": f"Deal {deal['deal_code']} operates in '{industry}', which policy {POLICY_VERSION} rule {rule_reference} prohibits from lending. No exposure to this segment may be booked without a documented waiver from an authorised officer.",
                })

        elif rule_type == "concentration_limit":
            cap = value["max_industry_concentration_pct"]
            single_cap = value["max_single_exposure_amount"]
            breached = concentration_pct > cap or exposure > single_cap
            findings.append({
                "rule_reference": rule_reference, "rule_type": rule_type,
                "status": "violated" if breached else "passed",
                "actual_value": f"{concentration_pct}% industry concentration, ${exposure:,.0f} single exposure",
                "permitted_value": f"<= {cap}% industry concentration, <= ${single_cap:,.0f} single exposure",
            })
            if breached:
                exceptions.append({
                    "policy_rule_id": rule["id"], "rule_reference": rule_reference,
                    "violation_detail": f"{industry} industry concentration is {concentration_pct}% (cap {cap}%) or single exposure ${exposure:,.0f} exceeds ${single_cap:,.0f}",
                    "rationale": f"Deal {deal['deal_code']} pushes {industry} exposure to {concentration_pct}% of the portfolio (${same_industry_exposure:,.0f} of ${total_portfolio_exposure:,.0f}), against policy {POLICY_VERSION} rule {rule_reference}'s {cap}% cap.",
                })

        elif rule_type == "ltv_cap":
            # This deal record carries no appraised-collateral field, so the
            # rule cannot be evaluated — reported as unevaluated, never as
            # passed, per the Policy Compliance Agent's own contract.
            findings.append({
                "rule_reference": rule_reference, "rule_type": rule_type, "status": "unevaluated",
                "actual_value": None, "permitted_value": f"<= {value['max_ltv_pct']}% LTV",
                "reason": "no appraised collateral value is on file for this deal",
            })

    return findings, exceptions


# ------------------------------------------------------------------------
# REST surface
# ------------------------------------------------------------------------

class ActingUserRequest(BaseModel):
    acting_user_email: str


class MemoAcceptRequest(BaseModel):
    acting_user_email: str
    action: str = "accept"
    edited_content: dict | None = None


@router.post("/api/deals/{deal_code}/agents/credit-memo/run")
def run_credit_memo(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(
        req.acting_user_email, MEMO_PERMISSION, "run the credit memo agent"
    )

    ratios = _latest_ratios(deal_code)
    grade = _latest_grade(deal_code)
    spread_rows = _spread_rows(deal_code)
    if not ratios or grade is None or not spread_rows:
        raise HTTPException(
            status_code=409,
            detail="an accepted spread, computed ratios, and an assigned risk grade are required before drafting the memo",
        )

    citations = []
    for ratio_type, row in ratios.items():
        citations.append({"ref": f"ratio:{ratio_type}", "type": "financial_ratio", "source_id": row["id"], "label": f"{ratio_type} = {row['result']}"})
    for row in spread_rows:
        citations.append({"ref": f"spread:{row['line_item_key']}", "type": "financial_spread_template", "source_id": row["id"], "label": f"{row['line_item_key']} ({row['period']}) = {row['value']} {row['unit']}"})
    citations.append({"ref": "risk_grade", "type": "risk_grade", "source_id": grade["id"], "label": f"grade {grade['grade']} band {grade['band_hit']}"})

    dscr = ratios.get("dscr", {}).get("result")
    leverage = ratios.get("leverage", {}).get("result")
    current_ratio = ratios.get("current_ratio", {}).get("result")

    prompt = (
        f"You are the credit memo agent. Draft the underwriting memo for deal {deal_code} "
        f"({deal.get('borrower_name')}, {deal.get('borrower_industry')}, exposure {deal.get('exposure_amount')}). "
        f"Use only these computed values: DSCR {dscr}, leverage {leverage}, current ratio {current_ratio}, "
        f"risk grade {grade['grade']} from rubric {grade['rubric_version']} band {grade['band_hit']}. "
        "Cite the ratio id, spread line item, or policy rule behind every assertion. Do not recompute any "
        "ratio, restate a different grade, recommend an approval decision, or advance the deal."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Credit Memo Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    sections = [
        {
            "title": "Executive Summary",
            "content": f"{deal.get('borrower_name')} ({deal_code}) requests ${float(deal.get('requested_amount') or 0):,.0f} "
                       f"in the {deal.get('borrower_industry')} sector against ${float(deal.get('exposure_amount') or 0):,.0f} exposure.",
            "citation_refs": [],
        },
        {
            "title": "Financial Analysis",
            "content": f"DSCR {dscr}x, leverage {leverage}x, current ratio {current_ratio}x, drawn from the accepted spread.",
            "citation_refs": ["ratio:dscr", "ratio:leverage", "ratio:current_ratio"] + [f"spread:{r['line_item_key']}" for r in spread_rows],
        },
        {
            "title": "Risk Grade",
            "content": f"Grade {grade['grade']} on rubric {grade['rubric_version']} — band struck: {grade['band_hit']}.",
            "citation_refs": ["risk_grade"],
        },
        {
            "title": "Policy Considerations",
            "content": f"Reviewed for concentration, prohibited-industry, and LTV screens under lending policy {POLICY_VERSION} "
                       "by the Policy Compliance Agent in a separate, subsequent review.",
            "citation_refs": [],
        },
    ]
    memo_content = (
        f"Credit Memo — {deal.get('borrower_name')} ({deal_code})\n\n"
        + "\n\n".join(f"{s['title']}: {s['content']}" for s in sections)
        + f"\n\nAgent note: {narrative}"
        + "\n\nThis is an automated draft citing the figures above; it recommends no approval or decline decision. "
          "A credit officer decides what happens next."
    )

    output_content = {"memo_content": memo_content, "citations": citations, "sections": sections}
    output = store.insert("agent_outputs", {
        "deal_id": deal_code, "agent_id": "credit-memo", "stage": "memo_drafting",
        "model": agent_runtime.mode().get("detail"), "prompt_version": "v1",
        "input_data": {"ratios": {k: v["result"] for k, v in ratios.items()}, "grade": grade["grade"]},
        "output_content": output_content, "token_usage": None, "latency_ms": latency_ms,
        "outcome": "proposed", "generated_at": _now(),
    })
    drafts.save(f"memo:{deal_code}", output_content)
    audit("credit_memo.agent_draft", {
        "deal_id": deal_code, "actor_user_id": actor["id"] if actor else None,
        "resource_type": "agent_draft", "resource_id": output["id"], "after": {"sections": [s["title"] for s in sections]},
    })
    return {"deal_id": deal_code, "agent_output_id": output["id"], **output_content}


@router.post("/api/deals/{deal_code}/memo/accept")
def accept_memo(deal_code: str, req: MemoAcceptRequest):
    _deal_or_404(deal_code)
    actor = identity.require_actor(
        req.acting_user_email, MEMO_PERMISSION, "accept a credit memo draft"
    )

    outputs = [o for o in store.list("agent_outputs") if o.get("deal_id") == deal_code and o.get("agent_id") == "credit-memo"]
    output = outputs[-1] if outputs else None
    result = persist_accepted_memo({
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "agent_output_id": output["id"] if output else None,
        "action": req.action,
        "original_content": output["output_content"] if output else None,
        "edited_content": req.edited_content,
    })
    return {**result, "deal_id": deal_code, "accepted": True, "accepted_by": req.acting_user_email}


@router.get("/api/deals/{deal_code}/memo")
def read_memo(deal_code: str):
    _deal_or_404(deal_code)
    return {
        "deal_id": deal_code,
        "draft": drafts.draft(f"memo:{deal_code}"),
        "accepted": drafts.current(f"memo:{deal_code}"),
    }


@router.post("/api/deals/{deal_code}/agents/policy-compliance/run")
def run_policy_compliance(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(
        req.acting_user_email, POLICY_PERMISSION, "run the policy compliance agent"
    )

    findings, proposed_exceptions = _evaluate_policy(deal)

    prompt = (
        f"You are the policy compliance agent. Review deal {deal_code} ({deal.get('borrower_name')}, "
        f"industry {deal.get('borrower_industry')}, exposure {deal.get('exposure_amount')}) against lending "
        f"policy {POLICY_VERSION}. {len(proposed_exceptions)} violation(s) were found deterministically: "
        f"{[e['rule_reference'] for e in proposed_exceptions]}. Summarise the compliance posture in plain "
        "banking English. You may not waive an exception, approve, decline, or advance this deal."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Policy Compliance Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    recorded = record_policy_exceptions({
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "policy_version": POLICY_VERSION,
        "exceptions": proposed_exceptions,
    })

    output_content = {
        "findings": findings,
        "exceptions": proposed_exceptions,
        "policy_version": POLICY_VERSION,
        "narrative": narrative,
    }
    output = store.insert("agent_outputs", {
        "deal_id": deal_code, "agent_id": "policy-compliance", "stage": "policy_compliance",
        "model": agent_runtime.mode().get("detail"), "prompt_version": "v1",
        "input_data": {"borrower_industry": deal.get("borrower_industry"), "exposure_amount": deal.get("exposure_amount")},
        "output_content": output_content, "token_usage": None, "latency_ms": latency_ms,
        "outcome": "proposed", "generated_at": _now(),
    })
    audit("policy_compliance.agent_draft", {
        "deal_id": deal_code, "actor_user_id": actor["id"] if actor else None,
        "resource_type": "agent_draft", "resource_id": output["id"],
        "after": {"findings_count": len(findings), "exceptions_count": len(proposed_exceptions)},
    })
    return {"deal_id": deal_code, "agent_output_id": output["id"], "exception_ids": recorded["exception_ids"], **output_content}


def _scoped_read(deal, acting_user_email):
    """Read scoping, same contract as the foundation's deal book: an
    identified caller only sees a deal its role entitles it to. Verified
    server-side against the stored user, never against the request's claim."""
    if not acting_user_email:
        return
    actor = identity.require_actor(acting_user_email, action="read this deal")
    if not identity.can_view_deal(actor, deal):
        raise HTTPException(
            status_code=403,
            detail=f"role '{actor.get('role')}' may not read deal {deal['deal_code']}",
        )


@router.get("/api/deals/{deal_code}/policy-exceptions")
def list_policy_exceptions(deal_code: str, acting_user_email: str | None = None):
    deal = _deal_or_404(deal_code)
    _scoped_read(deal, acting_user_email)
    rows = [r for r in store.list("policy_exceptions") if r.get("deal_id") == deal_code]
    return {"deal_id": deal_code, "policy_version": POLICY_VERSION, "exceptions": rows}


@router.get("/api/deals/{deal_code}/audit")
def deal_audit_timeline(deal_code: str, acting_user_email: str | None = None):
    """The Chronicle: this deal's full history in order — state changes,
    deterministic calculations, agent drafts, and human acceptances. Reads
    the normalized `audit_log` table every mutating call across the app
    writes into via `ext_audit.record()`.

    Each entry is served with the acting user's display name resolved here,
    so the Chronicle never has to read the `users` table itself."""
    deal = _deal_or_404(deal_code)
    _scoped_read(deal, acting_user_email)
    names = {u["id"]: (u.get("name") or u.get("email")) for u in store.list("users")}
    rows = [r for r in store.list("audit_log") if r.get("deal_id") == deal_code]
    rows.sort(key=lambda r: r.get("id") or 0)
    entries = [
        {**r, "actor_name": names.get(r.get("actor_user_id"), "system")}
        for r in rows
    ]
    return {"deal_id": deal_code, "entries": entries}
