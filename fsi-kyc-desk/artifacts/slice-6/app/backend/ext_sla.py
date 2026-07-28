"""Slice 5 — SLA clocks, at-risk flags and the escalation chain.

Implements the deterministic handlers behind the already-approved
`sla-escalation-monitor` workflow (workflows/workflows.json): a recurring
evaluator measures each undecided READY case against its band's business-hour
SLA (started by slice 1's `start_sla_clock`), flags it AT RISK to its
assigned approver at 80% consumed (`kyc_policy.AT_RISK_PERCENT`), records a
permanent breach once the window passes, and steps an unactioned High-band
case up the escalation chain — Compliance Officer -> Head of Financial Crime
-> COO. The evaluator never records a decision; `/decisions` (slice 4) is the
only door a case's status changes through.

`POST /sla/evaluate` accepts a `simulated_business_hours_elapsed` override so
the clock can be driven deterministically by a test or a demo, exactly the
way the slice plan's own acceptance checks do — it never depends on wall
clock time to pass, which the sandbox and the test suite cannot wait out.
Per SLICES.md's slice-1 note (g), the score and SLA fields are cleared on
every new cycle and only rewritten on the complete path, so this evaluator
skips any case with no live `sla_due_timestamp` rather than assuming one
exists, and also skips a cycle that already carries a decision.

Composition contract:
  * storage -> db.store only (`sla_tracking`, `notifications`, `escalations`,
               `audit_trail`; case rows themselves for `is_at_risk` /
               `sla_breached` — the same in-place-mutation idiom slice 1 uses)
  * process -> workflow_engine.register_handler for the four named handlers
  * audit   -> ext_cases.audit + the audit_trail table ("sla-evaluator" is
               already a recognised machine actor from slice 1)
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in
               main.py can never shadow them
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import kyc_policy as policy
import workflow_engine
from db import store
from ext_cases import audit, case_by_id, find_case

router = APIRouter()


# --------------------------------------------------------------------------
# Storage helpers
# --------------------------------------------------------------------------
def _current_sla_tracking(case_id, cycle):
    matches = [t for t in store.list("sla_tracking") if t["case_id"] == case_id and t.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


def _decision_exists(case_id, cycle):
    return any(a["case_id"] == case_id and a.get("cycle", 1) == cycle for a in store.list("approvals"))


def _parse_iso(value):
    import datetime

    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _evaluable_ready_cases():
    """Every READY case still carrying a live SLA clock and no decision yet."""
    out = []
    for row in store.list("cases"):
        if row.get("status") != "ready" or not row.get("sla_due_timestamp"):
            continue
        if _decision_exists(row["id"], row.get("cycle", 1)):
            continue
        out.append(row)
    return out


# --------------------------------------------------------------------------
# Workflow handlers — the implementation contract of sla-escalation-monitor
# --------------------------------------------------------------------------
def evaluate_case_sla_status(context):
    inputs = context.get("inputs") or {}
    row = find_case(inputs.get("case_reference"))
    if row is None:
        raise workflow_engine.WorkflowError("sla evaluate: case not found")
    case_id = row["id"]
    cycle = row.get("cycle", 1)
    band = row.get("risk_band") or "medium"
    sla_hours = row.get("sla_hours") or policy.sla_hours_for(band)
    start_iso = row.get("sla_start_timestamp")
    due_iso = row.get("sla_due_timestamp")
    simulated = inputs.get("simulated_business_hours_elapsed")
    if simulated is not None:
        elapsed = float(simulated)
    elif start_iso:
        elapsed = policy.business_hours_elapsed(_parse_iso(start_iso), policy.now_utc())
    else:
        elapsed = 0.0
    percent = round((elapsed / sla_hours) * 100, 1) if sla_hours else 0.0
    if percent >= 100:
        sla_state = "breached"
    elif percent >= policy.AT_RISK_PERCENT:
        sla_state = "at_risk"
    else:
        sla_state = "ok"
    return {
        "case_id": case_id,
        "case_reference": row.get("case_reference"),
        # workflows.json's high_risk_escalation_gate compares this to the
        # literal "High" — SLICES.md's slice-1 note (a). The case row itself
        # stays lowercase everywhere else.
        "risk_band": policy.band_label(band),
        "sla_hours": sla_hours,
        "sla_start_timestamp": start_iso,
        "sla_due_timestamp": due_iso,
        "elapsed_business_hours": elapsed,
        "percent_consumed": percent,
        "sla_state": sla_state,
        "decision_recorded": _decision_exists(case_id, cycle),
        "assigned_approver_id": row.get("assigned_approver_id"),
    }


def flag_case_at_risk_and_notify(context):
    """Flag AT RISK and notify — idempotent per cycle.

    A recurring evaluator polls the same still-at-risk case repeatedly; without
    a guard here, every poll would insert another "you are at risk" notice and
    another audit row for a fact that was already recorded. The bookkeeping
    fields on the sla_tracking row (`_at_risk_*`, prefixed like
    workflow_engine's own `_wf_events`) let a repeat poll return the SAME
    notification/audit ids rather than manufacturing new ones.
    """
    evaluated = context.get("evaluate_sla") or {}
    row = case_by_id(evaluated.get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("flag at risk: case not found")
    cycle = row.get("cycle", 1)
    tracking = _current_sla_tracking(row["id"], cycle)
    if row.get("is_at_risk") and tracking is not None and tracking.get("_at_risk_notification_id"):
        return {
            "case_id": row["id"],
            "is_at_risk": True,
            "flagged_at_risk_at": tracking.get("flagged_at_risk_at"),
            "notification_id": tracking["_at_risk_notification_id"],
            "recipient_user_id": tracking.get("_at_risk_recipient_id") or row.get("assigned_approver_id"),
            "audit_entry_id": tracking.get("_at_risk_audit_entry_id"),
        }
    now = policy.iso(policy.now_utc())
    was_at_risk = bool(row.get("is_at_risk"))
    row["is_at_risk"] = True
    if tracking is not None and not tracking.get("flagged_at_risk_at"):
        tracking["flagged_at_risk_at"] = now
    approver = row.get("assigned_approver_id") or policy.APPROVER_BY_BAND.get(
        str(row.get("risk_band")), "cora.compliance"
    )
    notification = store.insert(
        "notifications",
        {
            "case_id": row["id"],
            "notification_type": "at_risk",
            "recipient_user_id": approver,
            "sent_at": now,
            "message": (
                f"Case {row['case_reference']} is AT RISK — "
                f"{evaluated.get('percent_consumed')}% of its SLA window consumed."
            ),
            "read_at": None,
        },
    )
    entry = audit(
        row["id"],
        "sla_at_risk_flagged",
        "sla-evaluator",
        field_name="is_at_risk",
        old_value=was_at_risk,
        new_value=True,
        details={"percent_consumed": evaluated.get("percent_consumed"), "notification_id": notification["id"]},
    )
    if tracking is not None:
        tracking["_at_risk_notification_id"] = notification["id"]
        tracking["_at_risk_audit_entry_id"] = entry["id"]
        tracking["_at_risk_recipient_id"] = approver
    return {
        "case_id": row["id"],
        "is_at_risk": True,
        "flagged_at_risk_at": now,
        "notification_id": notification["id"],
        "recipient_user_id": approver,
        "audit_entry_id": entry["id"],
    }


def record_sla_breach(context):
    """Record the breach — idempotent per cycle; the breach itself is permanent.

    Same reasoning as flag_case_at_risk_and_notify: a High-band case can sit
    breached and undecided through many polls (each one also advancing the
    escalation chain — that repetition IS the intended behaviour, since each
    poll finding it still unactioned is itself the reason to escalate further).
    But "the case is breached" is a single fact, not a fresh event every poll,
    so re-recording an identical "sla_breached" audit row on every subsequent
    poll would misrepresent the trail as a new breach each time.
    """
    evaluated = context.get("evaluate_sla") or {}
    row = case_by_id(evaluated.get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("record breach: case not found")
    cycle = row.get("cycle", 1)
    tracking = _current_sla_tracking(row["id"], cycle)
    if row.get("sla_breached") and tracking is not None and tracking.get("_breach_audit_entry_id"):
        return {
            "case_id": row["id"],
            "breached": True,
            "breached_at": tracking.get("breached_at"),
            "permanent": True,
            "weekly_report_period": tracking.get("_breach_weekly_report_period"),
            "audit_entry_id": tracking["_breach_audit_entry_id"],
        }
    now_dt = policy.now_utc()
    now = policy.iso(now_dt)
    was_breached = bool(row.get("sla_breached"))
    row["sla_breached"] = True  # permanent — never cleared, even by a later decision (REQ-053)
    if tracking is not None and not tracking.get("breached"):
        tracking["breached"] = True
        tracking["breached_at"] = now
    period = now_dt.strftime("%Y-W%V")
    entry = audit(
        row["id"],
        "sla_breached",
        "sla-evaluator",
        field_name="sla_breached",
        old_value=was_breached,
        new_value=True,
        details={"weekly_report_period": period},
    )
    if tracking is not None:
        tracking["_breach_audit_entry_id"] = entry["id"]
        tracking["_breach_weekly_report_period"] = period
    return {
        "case_id": row["id"],
        "breached": True,
        "breached_at": now,
        "permanent": True,
        "weekly_report_period": period,
        "audit_entry_id": entry["id"],
    }


def advance_escalation_chain(context):
    evaluated = context.get("evaluate_sla") or {}
    row = case_by_id(evaluated.get("case_id"))
    if row is None:
        raise workflow_engine.WorkflowError("escalate: case not found")
    existing = [e for e in store.list("escalations") if e["case_id"] == row["id"]]
    current_level = max((e["escalation_level"] for e in existing), default=0)
    next_level = min(current_level + 1, len(policy.ESCALATION_CHAIN))
    step = policy.ESCALATION_CHAIN[next_level - 1]
    now = policy.iso(policy.now_utc())
    reason = f"Case {row['case_reference']} breached its SLA and remains undecided."
    escalation = store.insert(
        "escalations",
        {
            "case_id": row["id"],
            "escalation_level": next_level,
            "escalated_to_role": step["role"],
            "escalated_to_user_id": step["user_id"],
            "escalated_at": now,
            "reason": reason,
        },
    )
    notification = store.insert(
        "notifications",
        {
            "case_id": row["id"],
            "notification_type": "escalation",
            "recipient_user_id": step["user_id"],
            "sent_at": now,
            "message": (
                f"Case {row['case_reference']} escalated to level {next_level} "
                f"({step['role']}) — SLA breached and undecided."
            ),
            "read_at": None,
        },
    )
    entry = audit(
        row["id"],
        "case_escalated",
        "sla-evaluator",
        field_name="escalation_level",
        old_value=current_level,
        new_value=next_level,
        details={"escalated_to_role": step["role"], "escalated_to_user_id": step["user_id"]},
    )
    return {
        "case_id": row["id"],
        "escalation_id": escalation["id"],
        "escalation_level": next_level,
        "escalated_to_role": step["role"],
        "escalated_to_user_id": step["user_id"],
        "escalated_at": now,
        "reason": reason,
        "notification_id": notification["id"],
        "audit_entry_id": entry["id"],
    }


for _name, _fn in [
    ("evaluate_case_sla_status", evaluate_case_sla_status),
    ("flag_case_at_risk_and_notify", flag_case_at_risk_and_notify),
    ("record_sla_breach", record_sla_breach),
    ("advance_escalation_chain", advance_escalation_chain),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# Endpoints (registered outside /api/ — never shadowed by the catch-all)
# --------------------------------------------------------------------------
class SlaEvaluateRequest(BaseModel):
    simulated_business_hours_elapsed: float | None = None
    case_reference: str | None = None


@router.get("/sla-policy")
def get_sla_policy():
    """The versioned Escalation and SLA Policy every clock is run against."""
    return policy.sla_policy_definition()


@router.post("/sla/evaluate")
def evaluate_sla(req: SlaEvaluateRequest):
    """Run the sla-escalation-monitor workflow over every open, undecided clock.

    `case_reference` narrows evaluation to a single case; otherwise every
    READY case with a live SLA clock and no recorded decision is evaluated,
    each through its own run of the approved workflow.
    """
    if req.case_reference:
        row = find_case(req.case_reference)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no case with reference '{req.case_reference}'")
        targets = [row] if row.get("status") == "ready" and row.get("sla_due_timestamp") else []
    else:
        targets = _evaluable_ready_cases()

    results = []
    for row in targets:
        run_id = workflow_engine.start(
            "sla-escalation-monitor",
            {
                "case_reference": row["case_reference"],
                "simulated_business_hours_elapsed": req.simulated_business_hours_elapsed,
            },
        )
        state = workflow_engine.state(run_id)
        if state.get("status") == "failed":
            results.append({"case_reference": row["case_reference"], "error": state.get("error")})
            continue
        ctx = state.get("context") or {}

        def _reached(node_id):
            # A condition's on_false jump marks the node(s) it hops over as
            # {"skipped": True} rather than leaving them absent — a case that
            # never went AT RISK (jumped straight to breach_gate) still has a
            # "flag_at_risk" key in context, just not a real one.
            out = ctx.get(node_id) or {}
            return {} if out.get("skipped") else out

        evaluate_out = _reached("evaluate_sla")
        flag_out = _reached("flag_at_risk")
        breach_out = _reached("record_breach")
        escalate_out = _reached("escalate")
        results.append(
            {
                "case_reference": row["case_reference"],
                "workflow_run_id": run_id,
                "sla_state": evaluate_out.get("sla_state"),
                "risk_band": evaluate_out.get("risk_band"),
                "percent_consumed": evaluate_out.get("percent_consumed"),
                "elapsed_business_hours": evaluate_out.get("elapsed_business_hours"),
                "assigned_approver_id": evaluate_out.get("assigned_approver_id"),
                "is_at_risk": flag_out.get("is_at_risk", bool(row.get("is_at_risk"))),
                "notification": flag_out or None,
                "breached": breach_out.get("breached", bool(row.get("sla_breached"))),
                "breach": breach_out or None,
                "escalation": escalate_out or None,
            }
        )
    return {"evaluated": results, "count": len(results)}


@router.get("/escalations")
def list_escalations(case_reference: str | None = None):
    """Every escalation step ever recorded — addressable, never ephemeral (REQ-062)."""
    rows = store.list("escalations")
    if case_reference:
        target = find_case(case_reference)
        target_id = target["id"] if target else None
        rows = [e for e in rows if e["case_id"] == target_id]
    enriched = []
    for e in rows:
        case_row = case_by_id(e["case_id"])
        enriched.append(dict(e, case_reference=(case_row or {}).get("case_reference")))
    enriched.sort(key=lambda e: e["id"])
    return {"escalations": enriched, "count": len(enriched)}
