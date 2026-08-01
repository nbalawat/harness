"""ext_memo_policy_audit: slice `memo-policy-and-audit-trail`.

Three things, end to end:

1. **Credit memo.** The Credit Memo Agent drafts the underwriting memo from
   values that are already computed and accepted for the deal — the spread
   line items, the deterministic ratios, and the assigned risk grade — with a
   citation on every section. The agent never recomputes a figure: every
   number in the memo is copied from a stored record and carries the ratio id
   or spread line-item key it came from (R-010/R-011, roster eval criteria).
   The draft is a proposal; an analyst accepts, edits, or rejects it, and only
   that acceptance persists it (`persist_accepted_memo`).

2. **Policy compliance.** The Policy Compliance Agent tests the deal against
   the *active* lending ruleset. The rule arithmetic — LTV, DSCR floor,
   concentration, prohibited industry — is deterministic Python, never LLM
   output (R-049/R-055: no financial or policy math is delegated to a model);
   the agent supplies the written commentary. Every breach becomes a formal
   exception carrying rule_reference, violation_detail, rationale and status.
   Findings are proposed by the run and recorded as open exceptions only when
   a human accepts the review (`record_policy_exceptions`); an officer then
   waives or upholds each one (`resolve_policy_exceptions`).

3. **The chronicle.** `GET /api/deals/{code}/audit` reads the append-only
   `audit_log` table back in order and classifies each entry as a state
   change, a deterministic calculation, an agent draft, or a human decision,
   resolving the actor to a named user. There is no edit or delete path here
   and none anywhere else in the API (R-012/R-050/R-051/R-052).

Workflow contract: the `deal-underwriting-lifecycle` deterministic nodes
`savememo`, `exceptions` and `resolve` are the three handlers registered
below, invoked directly from the REST endpoints in this file (the same shape
slice 1 uses for `intake`/`route`) so their output schemas are honoured by
real, callable functions.
"""
import datetime
import time
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import deals_repo
import identity
import workflow_engine
from db import store
from ext_audit import record as audit

router = APIRouter()

POLICY_VERSION = "v4.2"
MEMO_TEMPLATE_VERSION = "memo-v1.7"
FIXTURE_DEAL = "DEAL-1003"


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _round2(value):
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _money(n):
    return f"${float(n):,.0f}"


# ---------------------------------------------------------------------------
# Reads over the shared tables (latest row wins — db.store is append-only)
# ---------------------------------------------------------------------------

def _deal_or_404(deal_code):
    deal = deals_repo.get_deal(deal_code)
    if deal is None:
        raise HTTPException(status_code=404, detail=f"no deal {deal_code}")
    return deal


def spread_rows(deal_code):
    """Latest accepted spread row per line item, keyed by line_item_key."""
    rows = {}
    for r in store.list("financial_spread_template"):
        if r.get("deal_id") == deal_code:
            rows[r.get("line_item_key")] = r
    return rows


def ratio_rows(deal_code):
    rows = {}
    for r in store.list("financial_ratios"):
        if r.get("deal_id") == deal_code:
            rows[r.get("ratio_type")] = r
    return rows


def risk_grade_row(deal_code):
    rows = [r for r in store.list("risk_grades") if r.get("deal_id") == deal_code]
    return rows[-1] if rows else None


def active_policy_rules():
    latest = {}
    for r in store.list("lending_policy"):
        if r.get("is_active"):
            latest[r.get("rule_key")] = r
    return latest


def _latest_output(deal_code, agent_id):
    outs = [
        o
        for o in store.list("agent_outputs")
        if o.get("deal_id") == deal_code and o.get("agent_id") == agent_id
    ]
    return outs[-1] if outs else None


def current_exceptions(deal_code):
    """Exceptions are append-only like every other row: the latest row for an
    `exception_ref` is that exception's current state."""
    latest = {}
    for r in store.list("policy_exceptions"):
        if r.get("deal_id") == deal_code:
            latest[r.get("exception_ref") or r.get("id")] = r
    return list(latest.values())


def _next_exception_ref():
    store.insert("_exception_ref_seq", {})
    return f"EX-{100 + len(store.list('_exception_ref_seq'))}"


# ---------------------------------------------------------------------------
# Deterministic policy engine — no model touches this arithmetic
# ---------------------------------------------------------------------------

def evaluate_policy(deal):
    """Test one deal against the active lending ruleset.

    Returns (findings, breaches, policy_version). A rule whose inputs are not
    on file is reported `unevaluated`, never `passed` (roster eval criterion).
    """
    deal_code = deal["deal_code"]
    rules = active_policy_rules()
    spread = spread_rows(deal_code)
    ratios = ratio_rows(deal_code)
    exposure = float(deal.get("exposure_amount") or 0)

    findings = []
    breaches = []

    def add(rule, status, observed, permitted, detail, rationale=None):
        finding = {
            "rule_reference": rule["rule_key"],
            "rule_type": rule.get("rule_type"),
            "policy_rule_id": rule.get("id"),
            "policy_version": rule.get("version"),
            "status": status,
            "observed": observed,
            "permitted": permitted,
            "detail": detail,
        }
        findings.append(finding)
        if status == "breached":
            breaches.append({
                "rule_reference": rule["rule_key"],
                "policy_rule_id": rule.get("id"),
                "violation_detail": detail,
                "rationale": rationale or detail,
                "status": "proposed",
            })

    # --- prohibited industry -------------------------------------------------
    rule = rules.get("PROHIBITED-IND-01")
    if rule:
        banned = list((rule.get("rule_value") or {}).get("industries") or [])
        industry = (deal.get("borrower_industry") or "").strip().lower()
        if not industry:
            add(rule, "unevaluated", None, banned, "borrower industry is not on file, so the prohibited-industry rule cannot be evaluated")
        elif industry in [b.lower() for b in banned]:
            add(
                rule, "breached", industry, banned,
                f"borrower industry '{industry}' is on the prohibited-industry list under {rule['rule_key']} ({POLICY_VERSION})",
                rationale=(
                    f"Lending in '{industry}' is prohibited outright by {rule['rule_key']}; the exposure cannot be "
                    "written under the active ruleset without an explicit officer waiver on the record."
                ),
            )
        else:
            add(rule, "passed", industry, banned, f"borrower industry '{industry}' is not a prohibited industry")

    # --- concentration limit -------------------------------------------------
    rule = rules.get("CONC-LIMIT-01")
    if rule:
        cap = float((rule.get("rule_value") or {}).get("max_single_obligor_exposure") or 0)
        obligor = deal.get("borrower_name")
        total = sum(
            float(d.get("exposure_amount") or 0)
            for d in deals_repo.all_current_deals()
            if d.get("borrower_name") == obligor and d.get("current_status") != "declined"
        )
        if not cap:
            add(rule, "unevaluated", total, None, "no single-obligor cap is configured on the active ruleset")
        elif total > cap:
            add(
                rule, "breached", total, cap,
                f"single-obligor exposure of {_money(total)} exceeds the {_money(cap)} concentration limit in {rule['rule_key']}",
                rationale=(
                    f"Aggregate exposure to {obligor} of {_money(total)} sits {_money(total - cap)} above the "
                    f"{_money(cap)} single-obligor ceiling; concentration risk must be dispositioned by a credit officer."
                ),
            )
        else:
            add(rule, "passed", total, cap, f"single-obligor exposure of {_money(total)} is within the {_money(cap)} limit")

    # --- loan-to-value cap ---------------------------------------------------
    rule = rules.get("LTV-CAP-01")
    if rule:
        cap = float((rule.get("rule_value") or {}).get("max_ltv_pct") or 0)
        collateral = spread.get("collateral_value")
        collateral_value = float(collateral.get("value") or 0) if collateral else 0.0
        if not collateral_value:
            add(rule, "unevaluated", None, cap, "no collateral value is on the accepted spread, so loan-to-value cannot be computed")
        else:
            ltv = _round2(exposure / collateral_value * 100)
            if ltv > cap:
                add(
                    rule, "breached", ltv, cap,
                    f"loan-to-value of {ltv}% exceeds the {cap}% cap in {rule['rule_key']} "
                    f"(exposure {_money(exposure)} against collateral {_money(collateral_value)})",
                    rationale=(
                        f"Collateral coverage is thin: at {ltv}% the advance is {_round2(ltv - cap)} percentage points "
                        f"above the {cap}% cap, so a shortfall on liquidation is not covered by the security position."
                    ),
                )
            else:
                add(rule, "passed", ltv, cap, f"loan-to-value of {ltv}% is within the {cap}% cap")

    # --- DSCR floor ----------------------------------------------------------
    rule = rules.get("DSCR-FLOOR-01")
    if rule:
        floor = float((rule.get("rule_value") or {}).get("min_dscr") or 0)
        dscr = ratios.get("dscr")
        if not dscr or dscr.get("result") is None:
            add(rule, "unevaluated", None, floor, "DSCR has not been computed for this deal, so the debt-service floor cannot be evaluated")
        else:
            value = float(dscr["result"])
            if value < floor:
                add(
                    rule, "breached", value, floor,
                    f"DSCR of {value} is below the {floor} policy floor in {rule['rule_key']}",
                    rationale=(
                        f"Debt service coverage of {value}x leaves no headroom against the {floor}x floor; a single "
                        "adverse quarter would put the borrower into a shortfall on scheduled service."
                    ),
                )
            else:
                add(rule, "passed", value, floor, f"DSCR of {value} clears the {floor} floor")

    return findings, breaches, POLICY_VERSION


# ---------------------------------------------------------------------------
# Deterministic memo assembly — figures are copied, never recomputed
# ---------------------------------------------------------------------------

def _fmt_ratio(row):
    if not row:
        return "not computed"
    return f"{row.get('result')}x ({row.get('numerator')} ÷ {row.get('denominator')})"


def build_memo_sections(deal, ratios, spread, grade, findings, narrative):
    deal_code = deal["deal_code"]
    borrower = deal.get("borrower_name") or deal_code
    exposure = float(deal.get("exposure_amount") or 0)
    citations = []

    def cite(ref, source_type, source_id, locator, quoted_text):
        entry = {
            "ref": ref,
            "source_type": source_type,
            "source_id": source_id,
            "locator": locator,
            "quoted_text": quoted_text,
        }
        citations.append(entry)
        return ref

    sections = []

    # 1. Borrower and request
    refs = [cite(f"DEAL-REF-{deal_code}", "deal", deal_code, "exposure_amount", str(exposure))]
    sections.append({
        "key": "borrower_and_request",
        "heading": "Borrower and Request",
        "body": (
            f"{borrower} ({deal_code}) operates in {deal.get('borrower_industry') or 'an unrecorded industry'} and has "
            f"requested {_money(deal.get('requested_amount') or 0)}, carrying a bank exposure of {_money(exposure)}."
        ),
        "citations": refs,
    })

    # 2. Financial position, straight off the accepted spread
    line_keys = [k for k in ("revenue", "ebitda", "net_operating_income", "total_debt", "collateral_value") if k in spread]
    refs = [
        cite(
            f"SPREAD-{spread[k]['line_item_key']}",
            "financial_spread_template",
            spread[k]["id"],
            spread[k]["line_item_key"],
            f"{spread[k]['value']} {spread[k].get('unit') or ''}".strip(),
        )
        for k in line_keys
    ]
    position = "; ".join(
        f"{k.replace('_', ' ')} {_money(spread[k]['value'])} ({spread[k].get('period')})" for k in line_keys
    ) or "no accepted spread lines are on file"
    template = list(spread.values())[0].get("template_version") if spread else "n/a"
    sections.append({
        "key": "financial_position",
        "heading": "Financial Position",
        "body": f"Drawn from the accepted spread, template {template}: {position}.",
        "citations": refs,
    })

    # 3. Ratio analysis — values copied verbatim from the computed records
    refs = []
    for key in ("dscr", "leverage", "current_ratio"):
        row = ratios.get(key)
        if row:
            refs.append(cite(f"RATIO-{row['id']}", "financial_ratios", row["id"], key, str(row.get("result"))))
    sections.append({
        "key": "ratio_analysis",
        "heading": "Ratio Analysis",
        "body": (
            f"Debt service coverage stands at {_fmt_ratio(ratios.get('dscr'))}; leverage at "
            f"{_fmt_ratio(ratios.get('leverage'))}; current ratio at {_fmt_ratio(ratios.get('current_ratio'))}. "
            "These figures are taken as computed by the deterministic ratio module and are not restated here."
        ),
        "citations": refs,
    })

    # 4. Risk grade
    refs = []
    if grade:
        refs.append(cite(f"GRADE-{grade['id']}", "risk_grades", grade["id"], grade.get("rubric_version"), str(grade.get("grade"))))
        grade_body = (
            f"The deal carries risk grade {grade.get('grade')} under rubric {grade.get('rubric_version')}, band "
            f"{grade.get('band_hit')}. {grade.get('reasoning') or ''}"
        ).strip()
    else:
        grade_body = "No risk grade has been assigned to this deal yet."
    sections.append({
        "key": "risk_grade",
        "heading": "Assigned Risk Grade",
        "body": grade_body,
        "citations": refs,
    })

    # 5. Policy context (rule references only — the compliance run owns the verdict)
    refs = [
        cite(f"POLICY-{f['rule_reference']}", "lending_policy", f.get("policy_rule_id"), f["rule_reference"], f["detail"])
        for f in findings
    ]
    sections.append({
        "key": "policy_context",
        "heading": "Policy Context",
        "body": (
            "Rules tested against the active lending policy "
            + POLICY_VERSION
            + ": "
            + ("; ".join(f"{f['rule_reference']} {f['status']}" for f in findings) or "no active rules are configured")
            + "."
        ),
        "citations": refs,
    })

    # 6. Agent commentary — the only free prose, and it decides nothing
    sections.append({
        "key": "analyst_commentary",
        "heading": "Agent Commentary",
        "body": narrative,
        "citations": [cite(f"DEAL-REF-{deal_code}-commentary", "deal", deal_code, "borrower_name", borrower)],
    })

    memo_content = "\n\n".join(f"{s['heading']}\n{s['body']}" for s in sections)
    return sections, citations, memo_content


# ---------------------------------------------------------------------------
# workflow-engine handlers (deal-underwriting-lifecycle: savememo, exceptions,
# resolve). Each is independently reachable through workflow_engine.start(),
# so each re-checks the acting user's authority at the point of state change.
# ---------------------------------------------------------------------------

def _require(actor_user_id, permission, what):
    actor = next((u for u in store.list("users") if u.get("id") == actor_user_id), None)
    if not identity.has_permission(actor, permission):
        raise HTTPException(status_code=403, detail=f"lacks the authority to {what}")
    return actor


def persist_accepted_memo(context):
    """Node `savememo`: an analyst has accepted (or edited) the memo draft."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("reviewed_by_user_id")
    _require(actor_user_id, "deal.memo", "accept a credit memo")

    draft = context.get("memo_draft") or {}
    action = context.get("action") or "accept"
    edited = context.get("edited_content")
    final_content = edited if (action == "accept_with_edits" and edited) else draft.get("memo_content")

    memo = store.insert("agent_outputs", {
        "deal_id": deal_code,
        "agent_id": "credit-memo",
        "stage": "memo_drafting",
        "model": agent_runtime.mode().get("detail"),
        "prompt_version": MEMO_TEMPLATE_VERSION,
        "input_data": draft.get("input_data"),
        "output_content": {**draft, "memo_content": final_content},
        "token_usage": None,
        "latency_ms": None,
        "outcome": "accepted_with_edits" if (action == "accept_with_edits" and edited) else "accepted",
        "generated_at": _now(),
    })

    citation_ids = []
    for c in draft.get("citations") or []:
        row = store.insert("citations", {
            "source_type": "credit_memo",
            "source_id": memo["id"],
            "document_id": c.get("document_id"),
            "page_number": c.get("page_number"),
            "section": c.get("locator"),
            "cell_locator": c.get("ref"),
            "quoted_text": c.get("quoted_text"),
            "created_at": _now(),
        })
        citation_ids.append(row["id"])

    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": actor_user_id,
        "action": action,
        "original_content": draft.get("memo_content"),
        "edited_content": edited,
        "rejection_reason": context.get("rejection_reason"),
        "reviewed_at": _now(),
    })

    before = deals_repo.get_deal(deal_code)
    updated = deals_repo.update_deal(
        deal_code,
        current_stage="policy_compliance",
        current_status="memo_accepted",
        last_activity_timestamp=_now(),
    )
    entry = audit("memo.accepted", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "credit_memo",
        "resource_id": memo["id"],
        "before": {"current_stage": (before or {}).get("current_stage"), "memo": "draft"},
        "after": {"current_stage": updated["current_stage"], "memo": memo["outcome"], "citation_ids": citation_ids},
    })
    return {
        "memo_id": memo["id"],
        "citation_ids": citation_ids,
        "review_id": review["id"],
        "reviewed_by_user_id": actor_user_id,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("persist_accepted_memo", persist_accepted_memo)


def record_policy_exceptions(context):
    """Node `exceptions`: writes one formal exception row per breach."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("reviewed_by_user_id")
    _require(actor_user_id, "deal.policy_check", "record policy exceptions")

    breaches = context.get("breaches") or []
    exception_ids = []
    refs = []
    for b in breaches:
        ref = _next_exception_ref()
        row = store.insert("policy_exceptions", {
            "deal_id": deal_code,
            "exception_ref": ref,
            "policy_rule_id": b.get("policy_rule_id"),
            "rule_reference": b.get("rule_reference"),
            "violation_detail": b.get("violation_detail"),
            "rationale": b.get("rationale"),
            "status": "open",
            "raised_by_user_id": actor_user_id,
            "resolved_by_user_id": None,
            "resolved_at": None,
            "created_at": _now(),
        })
        exception_ids.append(row["id"])
        refs.append(ref)

    review = store.insert("human_reviews", {
        "agent_output_id": context.get("agent_output_id"),
        "deal_id": deal_code,
        "reviewed_by_user_id": actor_user_id,
        "action": context.get("action") or "accept",
        "original_content": context.get("findings"),
        "edited_content": None,
        "rejection_reason": None,
        "reviewed_at": _now(),
    })

    open_count = len([e for e in current_exceptions(deal_code) if e.get("status") == "open"])
    entry = audit("policy.exceptions_recorded", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "policy_exception",
        "resource_id": exception_ids[0] if exception_ids else None,
        "after": {
            "policy_version": POLICY_VERSION,
            "exception_refs": refs,
            "exception_ids": exception_ids,
            "open_exception_count": open_count,
        },
    })
    return {
        "policy_version": POLICY_VERSION,
        "exception_ids": exception_ids,
        "exception_refs": refs,
        "open_exception_count": open_count,
        "has_open_exceptions": open_count > 0,
        "review_id": review["id"],
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("record_policy_exceptions", record_policy_exceptions)


def resolve_policy_exceptions(context):
    """Node `resolve`: an officer waives (with rationale) or upholds an
    exception. The agent that raised it is denied this tool by the roster."""
    deal_code = context["deal_id"]
    actor_user_id = context.get("resolved_by_user_id")
    actor = _require(actor_user_id, "deal.approve", "waive or uphold a policy exception")

    decisions = context.get("decisions") or []
    resolved_at = _now()
    resolved_ids = []
    by_ref = {e.get("exception_ref"): e for e in current_exceptions(deal_code)}
    for decision in decisions:
        ref = decision.get("exception_ref")
        current = by_ref.get(ref)
        if current is None:
            raise HTTPException(status_code=404, detail=f"no policy exception {ref} on {deal_code}")
        status = "waived" if decision.get("disposition") == "waive" else "upheld"
        rationale = (decision.get("rationale") or "").strip()
        if not rationale:
            raise HTTPException(status_code=400, detail="a written rationale is required to dispose of a policy exception")
        row = dict(current)
        row.pop("id", None)
        row.update({
            "status": status,
            "rationale": rationale,
            "resolved_by_user_id": actor_user_id,
            "resolved_at": resolved_at,
        })
        store.insert("policy_exceptions", row)
        resolved_ids.append(ref)

    open_count = len([e for e in current_exceptions(deal_code) if e.get("status") == "open"])
    entry = audit("policy.exceptions_resolved", {
        "deal_id": deal_code,
        "actor_user_id": actor_user_id,
        "resource_type": "policy_exception",
        "resource_id": resolved_ids[0] if resolved_ids else None,
        "before": {"status": "open"},
        "after": {
            "resolved_exception_refs": resolved_ids,
            "open_exception_count": open_count,
            "resolved_by": (actor or {}).get("email"),
        },
    })
    return {
        "resolved_exception_ids": resolved_ids,
        "open_exception_count": open_count,
        "resolved_by_user_id": actor_user_id,
        "resolved_at": resolved_at,
        "audit_entry_id": entry["id"],
    }


workflow_engine.register_handler("resolve_policy_exceptions", resolve_policy_exceptions)


# ---------------------------------------------------------------------------
# REST surface
# ---------------------------------------------------------------------------

class ActingUserRequest(BaseModel):
    acting_user_email: str


class MemoReviewRequest(BaseModel):
    acting_user_email: str
    action: str = "accept"
    edited_content: str | None = None
    rejection_reason: str | None = None


class ExceptionDecision(BaseModel):
    exception_ref: str
    disposition: str  # "waive" | "uphold"
    rationale: str


class ResolveRequest(BaseModel):
    acting_user_email: str
    decisions: list[ExceptionDecision]


@router.post("/api/deals/{deal_code}/agents/credit-memo/run")
def run_credit_memo(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.memo", "run the credit memo agent")

    ratios = ratio_rows(deal_code)
    spread = spread_rows(deal_code)
    grade = risk_grade_row(deal_code)
    findings, _breaches, _version = evaluate_policy(deal)

    prompt = (
        f"You are the credit memo agent. Draft commentary for deal {deal_code} "
        f"({deal.get('borrower_name')}, {deal.get('borrower_industry')}, exposure {deal.get('exposure_amount')}). "
        f"Use ONLY these already-computed values: DSCR {(ratios.get('dscr') or {}).get('result')}, leverage "
        f"{(ratios.get('leverage') or {}).get('result')}, current ratio {(ratios.get('current_ratio') or {}).get('result')}, "
        f"risk grade {(grade or {}).get('grade')} from rubric {(grade or {}).get('rubric_version')} band "
        f"{(grade or {}).get('band_hit')}, and the accepted spread line items "
        f"{sorted(spread.keys())}. Cite the ratio id, spread line item, or policy rule behind every assertion. "
        "Do not recompute a ratio, do not restate a different grade, do not offer a lending decision or "
        "recommendation of any kind, and do not advance the deal — a human analyst accepts, edits, or rejects "
        "this draft."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Credit Memo Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    sections, citations, memo_content = build_memo_sections(deal, ratios, spread, grade, findings, narrative)
    input_data = {
        "deal_code": deal_code,
        "ratio_ids": {k: v["id"] for k, v in ratios.items()},
        "spread_line_items": sorted(spread.keys()),
        "risk_grade_id": (grade or {}).get("id"),
        "policy_version": POLICY_VERSION,
    }
    output_content = {
        "memo_content": memo_content,
        "sections": sections,
        "citations": citations,
        "template_version": MEMO_TEMPLATE_VERSION,
        "input_data": input_data,
    }
    output = store.insert("agent_outputs", {
        "deal_id": deal_code,
        "agent_id": "credit-memo-draft",
        "stage": "memo_drafting",
        "model": agent_runtime.mode().get("detail"),
        "prompt_version": MEMO_TEMPLATE_VERSION,
        "input_data": input_data,
        "output_content": output_content,
        "token_usage": None,
        "latency_ms": latency_ms,
        "outcome": "proposed",
        "generated_at": _now(),
    })
    audit("memo.agent_drafted", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "resource_type": "agent_output",
        "resource_id": output["id"],
        "after": {
            "agent": "Credit Memo Agent",
            "template_version": MEMO_TEMPLATE_VERSION,
            "section_count": len(sections),
            "citation_count": len(citations),
            "latency_ms": latency_ms,
            "memo_content": memo_content,
        },
    })
    return {
        "deal_id": deal_code,
        "agent_output_id": output["id"],
        "memo_content": memo_content,
        "sections": sections,
        "citations": citations,
        "template_version": MEMO_TEMPLATE_VERSION,
        "outcome": "proposed",
        "review_required": True,
    }


def _scoped_deal(deal_code, acting_user_email):
    """Read guard shared by this slice's GETs.

    A caller that identifies itself is resolved and checked against the deal's
    visibility rules before anything is returned; an anonymous read follows the
    same contract as the foundation's `GET /api/deals` / `GET /api/pipeline`,
    which the desk UI and the recorded acceptance checks call without
    credentials. Every WRITE on this slice is identity-guarded without
    exception.
    """
    deal = _deal_or_404(deal_code)
    if acting_user_email:
        actor = identity.require_actor(acting_user_email, action=f"read {deal_code}")
        if not identity.can_view_deal(actor, deal):
            raise HTTPException(status_code=403, detail=f"role '{actor.get('role')}' may not read {deal_code}")
    return deal


@router.get("/api/deals/{deal_code}/memo")
def get_memo(deal_code: str, acting_user_email: str | None = None):
    _scoped_deal(deal_code, acting_user_email)
    draft = _latest_output(deal_code, "credit-memo-draft")
    accepted = _latest_output(deal_code, "credit-memo")
    return {
        "deal_id": deal_code,
        "draft": (draft or {}).get("output_content"),
        "draft_id": (draft or {}).get("id"),
        "accepted": (accepted or {}).get("output_content"),
        "accepted_id": (accepted or {}).get("id"),
        "status": (accepted or {}).get("outcome") or ("proposed" if draft else "not_drafted"),
    }


@router.post("/api/deals/{deal_code}/memo/accept")
def accept_memo(deal_code: str, req: MemoReviewRequest):
    _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.memo", "accept a credit memo draft")
    draft = _latest_output(deal_code, "credit-memo-draft")
    if draft is None:
        raise HTTPException(status_code=409, detail="run the credit memo agent before accepting its draft")
    if req.action == "reject":
        review = store.insert("human_reviews", {
            "agent_output_id": draft["id"],
            "deal_id": deal_code,
            "reviewed_by_user_id": actor["id"],
            "action": "reject",
            "original_content": draft["output_content"].get("memo_content"),
            "edited_content": None,
            "rejection_reason": req.rejection_reason or "no reason given",
            "reviewed_at": _now(),
        })
        audit("memo.rejected", {
            "deal_id": deal_code,
            "actor_user_id": actor["id"],
            "resource_type": "agent_output",
            "resource_id": draft["id"],
            "after": {"action": "reject", "rejection_reason": req.rejection_reason},
        })
        return {"deal_id": deal_code, "status": "rejected", "review_id": review["id"]}

    result = persist_accepted_memo({
        "deal_id": deal_code,
        "reviewed_by_user_id": actor["id"],
        "agent_output_id": draft["id"],
        "memo_draft": draft["output_content"],
        "action": req.action,
        "edited_content": req.edited_content,
    })
    deal = deals_repo.get_deal(deal_code)
    return {**result, "deal_id": deal_code, "status": "accepted", "current_stage": deal["current_stage"]}


@router.post("/api/deals/{deal_code}/agents/policy-compliance/run")
def run_policy_compliance(deal_code: str, req: ActingUserRequest):
    deal = _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.policy_check", "run the policy compliance agent")

    findings, breaches, policy_version = evaluate_policy(deal)
    memo = _latest_output(deal_code, "credit-memo") or _latest_output(deal_code, "credit-memo-draft")

    prompt = (
        f"You are the policy compliance agent. Deal {deal_code} ({deal.get('borrower_name')}, industry "
        f"{deal.get('borrower_industry')}, exposure {deal.get('exposure_amount')}) was tested against lending policy "
        f"{policy_version}. The deterministic rule engine returned these results: {findings}. Summarise what the desk "
        "must know about the breaches, citing the rule reference for each. You may not waive an exception, approve, "
        "decline, or advance the deal."
    )
    started = time.monotonic()
    narrative = agent_runtime.respond(prompt, agent_name="Policy Compliance Agent")
    latency_ms = int((time.monotonic() - started) * 1000)

    output_content = {
        "findings": findings,
        "exceptions": breaches,
        "policy_version": policy_version,
        "memo_id": (memo or {}).get("id"),
        "narrative": narrative,
    }
    output = store.insert("agent_outputs", {
        "deal_id": deal_code,
        "agent_id": "policy-compliance",
        "stage": "policy_compliance",
        "model": agent_runtime.mode().get("detail"),
        "prompt_version": policy_version,
        "input_data": {"deal_code": deal_code, "policy_version": policy_version, "memo_id": (memo or {}).get("id")},
        "output_content": output_content,
        "token_usage": None,
        "latency_ms": latency_ms,
        "outcome": "proposed",
        "generated_at": _now(),
    })
    audit("policy.agent_reviewed", {
        "deal_id": deal_code,
        "actor_user_id": actor["id"] if actor else None,
        "resource_type": "agent_output",
        "resource_id": output["id"],
        "after": {
            "agent": "Policy Compliance Agent",
            "policy_version": policy_version,
            "rules_tested": [f["rule_reference"] for f in findings],
            "breached": [b["rule_reference"] for b in breaches],
            "latency_ms": latency_ms,
        },
    })
    return {
        "deal_id": deal_code,
        "agent_output_id": output["id"],
        "findings": findings,
        "exceptions": breaches,
        "policy_version": policy_version,
        "outcome": "proposed",
        "review_required": True,
    }


@router.post("/api/deals/{deal_code}/policy-review/accept")
def accept_policy_review(deal_code: str, req: ActingUserRequest):
    _deal_or_404(deal_code)
    actor = identity.require_actor(req.acting_user_email, "deal.policy_check", "record policy exceptions")
    output = _latest_output(deal_code, "policy-compliance")
    if output is None:
        raise HTTPException(status_code=409, detail="run the policy compliance agent before recording its exceptions")
    already = {e.get("rule_reference") for e in current_exceptions(deal_code)}
    breaches = [b for b in output["output_content"]["exceptions"] if b["rule_reference"] not in already]
    result = record_policy_exceptions({
        "deal_id": deal_code,
        "reviewed_by_user_id": actor["id"],
        "agent_output_id": output["id"],
        "breaches": breaches,
        "findings": output["output_content"]["findings"],
        "action": "accept",
    })
    return {**result, "deal_id": deal_code, "status": "recorded"}


@router.get("/api/deals/{deal_code}/policy-exceptions")
def list_policy_exceptions(deal_code: str, acting_user_email: str | None = None):
    """Recorded exceptions plus, clearly marked, any breach the latest agent
    run proposed that a human has not yet accepted onto the record."""
    _scoped_deal(deal_code, acting_user_email)
    recorded = current_exceptions(deal_code)
    for e in recorded:
        e["origin"] = "recorded"
    already = {e.get("rule_reference") for e in recorded}
    output = _latest_output(deal_code, "policy-compliance")
    proposed = []
    if output:
        for b in output["output_content"]["exceptions"]:
            if b["rule_reference"] not in already:
                proposed.append({**b, "status": "proposed", "origin": "pending_human_review", "deal_id": deal_code})
    return {
        "deal_id": deal_code,
        "policy_version": POLICY_VERSION,
        "exceptions": recorded + proposed,
        "recorded": recorded,
        "proposed": proposed,
        "open_exception_count": len([e for e in recorded if e.get("status") == "open"]),
    }


@router.post("/api/deals/{deal_code}/policy-exceptions/resolve")
def resolve_exceptions(deal_code: str, req: ResolveRequest):
    _deal_or_404(deal_code)
    actor = identity.require_actor(
        req.acting_user_email, "deal.approve", "waive or uphold a policy exception"
    )
    result = resolve_policy_exceptions({
        "deal_id": deal_code,
        "resolved_by_user_id": actor["id"],
        "decisions": [d.model_dump() for d in req.decisions],
    })
    return {**result, "deal_id": deal_code}


# ---------------------------------------------------------------------------
# The chronicle
# ---------------------------------------------------------------------------

_AGENT_ACTIONS = ("agent_run", "agent_drafted", "agent_reviewed")
_HUMAN_ACTIONS = ("accepted", "rejected", "resolved", "recorded", "approved", "declined", "returned", "waived")
_CALCULATION_ACTIONS = ("ratios.", "grade.", "computed", "calculated")


def classify_entry(action):
    a = (action or "").lower()
    if any(token in a for token in _AGENT_ACTIONS):
        return "agent_draft"
    if any(a.startswith(token) or token in a for token in _CALCULATION_ACTIONS):
        return "calculation"
    if any(a.endswith(token) or f".{token}" in a for token in _HUMAN_ACTIONS):
        return "human_decision"
    return "state_change"


@router.get("/api/deals/{deal_code}/audit")
def deal_audit_timeline(deal_code: str, acting_user_email: str | None = None, kind: str | None = None):
    """The per-deal chronicle, oldest first. Append-only: this router exposes
    no update or delete path for an audit row, and none exists elsewhere.

    Read scoping follows the same contract as `GET /api/deals`: a caller that
    identifies itself is checked against the deal's visibility rules before a
    single entry is returned.
    """
    deal = _scoped_deal(deal_code, acting_user_email)

    users = {u["id"]: u for u in store.list("users")}
    entries = []
    for row in store.list("audit_log"):
        if row.get("deal_id") != deal_code:
            continue
        user = users.get(row.get("actor_user_id")) or {}
        entry_kind = classify_entry(row.get("action"))
        after = row.get("after_payload") or {}
        entries.append({
            "id": row["id"],
            "seq": len(entries) + 1,
            "deal_id": deal_code,
            "action": row.get("action"),
            "entry_kind": entry_kind,
            "actor_user_id": row.get("actor_user_id"),
            "actor_email": user.get("email") or ("system" if row.get("actor_user_id") is None else None),
            "actor_name": user.get("name") or "System",
            "actor_role": user.get("role") or "system",
            "resource_type": row.get("resource_type"),
            "resource_id": row.get("resource_id"),
            "before_payload": row.get("before_payload"),
            "after_payload": row.get("after_payload"),
            "agent_draft": after.get("agent") if entry_kind == "agent_draft" else None,
            "timestamp": row.get("timestamp"),
        })

    counts = {"all": len(entries)}
    for k in ("human_decision", "agent_draft", "calculation", "state_change"):
        counts[k] = len([e for e in entries if e["entry_kind"] == k])
    shown = [e for e in entries if not kind or kind == "all" or e["entry_kind"] == kind] if kind else entries
    return {
        "deal_id": deal_code,
        "borrower_name": deal.get("borrower_name"),
        "append_only": True,
        "entries": shown,
        "counts": counts,
    }


# ---------------------------------------------------------------------------
# Fixtures: the active lending ruleset, and one deal that has already been
# spread, calculated and graded so the memo/policy desk has real cited inputs
# and the chronicle has a history the moment the app boots.
#
# Deal rows are inserted with an explicit `deal_code` (never through
# deals_repo.create_deal) so the DEAL-1001+ sequence handed to freshly filed
# deals is untouched — see deals_repo.next_deal_code().
# ---------------------------------------------------------------------------

POLICY_RULES = [
    {
        "version": POLICY_VERSION,
        "rule_type": "prohibited_industry",
        "rule_key": "PROHIBITED-IND-01",
        "rule_value": {"industries": ["payday_lending", "cannabis", "crypto_mining", "gambling", "arms_dealing"]},
    },
    {
        "version": POLICY_VERSION,
        "rule_type": "concentration_limit",
        "rule_key": "CONC-LIMIT-01",
        "rule_value": {"max_single_obligor_exposure": 1500000},
    },
    {
        "version": POLICY_VERSION,
        "rule_type": "ltv_cap",
        "rule_key": "LTV-CAP-01",
        "rule_value": {"max_ltv_pct": 75},
    },
    {
        "version": POLICY_VERSION,
        "rule_type": "dscr_floor",
        "rule_key": "DSCR-FLOOR-01",
        "rule_value": {"min_dscr": 1.25},
    },
]

FIXTURE_SPREAD = [
    ("revenue", 4820000, "USD"),
    ("ebitda", 712000, "USD"),
    ("net_operating_income", 712000, "USD"),
    ("total_debt_service", 574200, "USD"),
    ("total_debt", 2207000, "USD"),
    ("current_assets", 611000, "USD"),
    ("current_liabilities", 430300, "USD"),
    ("collateral_value", 1463000, "USD"),
]

FIXTURE_RATIOS = [
    ("dscr", 712000, 574200),
    ("leverage", 2207000, 712000),
    ("current_ratio", 611000, 430300),
]


def _install_policy_rules():
    existing = {r.get("rule_key") for r in store.list("lending_policy") if r.get("version") == POLICY_VERSION}
    for rule in POLICY_RULES:
        if rule["rule_key"] in existing:
            continue
        store.insert("lending_policy", {**rule, "is_active": True, "created_at": _now(), "updated_at": _now()})


def _install_fixture_deal():
    if deals_repo.get_deal(FIXTURE_DEAL) is not None:
        return
    rm = identity.resolve_user("rm@bank.test", default_role=identity.RELATIONSHIP_MANAGER)
    analyst = identity.resolve_user("analyst@bank.test", default_role=identity.CREDIT_ANALYST)

    store.insert("deals", {
        "deal_code": FIXTURE_DEAL,
        "borrower_name": "Calder & Vance Millworks",
        "borrower_industry": "specialty_millwork",
        "borrower_entity_id": "ENT-44120",
        "requested_amount": 1200000,
        "exposure_amount": 1200000,
        "current_stage": "memo_drafting",
        "current_status": "spread_accepted",
        "created_by_user_id": rm["id"],
        "assigned_to_user_id": analyst["id"],
        "risk_grade": "4",
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": _now(),
        "created_at": _now(),
        "updated_at": _now(),
    })

    document = store.insert("documents", {
        "deal_id": FIXTURE_DEAL,
        "document_type": "financial_statements",
        "file_name": "calder-vance-fy2025-statements.pdf",
        "file_size": 481233,
        "checksum": "sha256:2f7a1c",
        "storage_path": "blobs/calder-vance-fy2025-statements.pdf",
        "uploaded_by_user_id": rm["id"],
        "uploaded_at": _now(),
        "created_at": _now(),
    })

    for index, (key, value, unit) in enumerate(FIXTURE_SPREAD):
        row = store.insert("financial_spread_template", {
            "deal_id": FIXTURE_DEAL,
            "template_version": "spread-v3",
            "line_item_key": key,
            "period": "FY2025",
            "value": value,
            "unit": unit,
            "created_at": _now(),
        })
        store.insert("citations", {
            "source_type": "financial_spread_template",
            "source_id": row["id"],
            "document_id": document["id"],
            "page_number": 3 + (index // 3),
            "section": "Statement of Financial Position",
            "cell_locator": f"B{12 + index}",
            "quoted_text": f"{key} {value} {unit}",
            "created_at": _now(),
        })
    audit("spread.accepted", {
        "deal_id": FIXTURE_DEAL,
        "actor_user_id": analyst["id"],
        "resource_type": "financial_spread",
        "resource_id": FIXTURE_DEAL,
        "before": {"spread": "draft"},
        "after": {"spread": "accepted", "template_version": "spread-v3", "line_items": len(FIXTURE_SPREAD)},
    })

    for ratio_type, numerator, denominator in FIXTURE_RATIOS:
        store.insert("financial_ratios", {
            "deal_id": FIXTURE_DEAL,
            "ratio_type": ratio_type,
            "numerator": numerator,
            "denominator": denominator,
            "result": _round2(numerator / denominator),
            "rounding_method": "half_up_2dp",
            "divide_by_zero_handling": "null_result_flagged",
            "computed_at": _now(),
            "created_at": _now(),
        })
    audit("ratios.computed", {
        "deal_id": FIXTURE_DEAL,
        "actor_user_id": None,
        "resource_type": "financial_ratios",
        "resource_id": FIXTURE_DEAL,
        "after": {
            "dscr": _round2(712000 / 574200),
            "leverage": _round2(2207000 / 712000),
            "current_ratio": _round2(611000 / 430300),
            "rounding_method": "half_up_2dp",
        },
    })

    store.insert("risk_grades", {
        "deal_id": FIXTURE_DEAL,
        "grade": "4",
        "rubric_version": "rubric-v2.1",
        "band_hit": "band_4_watch",
        "reasoning": "DSCR between 1.20 and 1.35 with leverage above 3.0 strikes band four of the rubric.",
        "computed_at": _now(),
        "created_at": _now(),
    })
    audit("grade.assigned", {
        "deal_id": FIXTURE_DEAL,
        "actor_user_id": None,
        "resource_type": "risk_grade",
        "resource_id": FIXTURE_DEAL,
        "before": {"grade": None},
        "after": {"grade": "4", "rubric_version": "rubric-v2.1", "band_hit": "band_4_watch"},
    })


_install_policy_rules()
_install_fixture_deal()
