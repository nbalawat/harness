"""portfolio-qa-sla-audit slice: SLA dashboard portion.

Implements the `sla-escalation` workflow (workflows/workflows.json):
compute_idle_ages -> [check_breaches] -> flag_sla_breaches ->
summarize_breaches (agent) -> [escalation_decision: human] ->
apply_escalation_decision. The three deterministic nodes are registered as
real workflow_engine handlers under the exact names the workflow definition
calls out, so driving `POST /workflows/sla-escalation/start` runs the sweep
end to end and parks at the human escalation_decision gate.

GET /sla/dashboard below calls the SAME deterministic idle-age computation
directly (no workflow run needed to view a live dashboard), matching every
earlier slice's pattern of a REST surface driving its own handler functions.

Composition contract:
  * storage -> db.store only (deals, sla_tracking, audit_trail) — no
               hand-rolled bookkeeping
  * time    -> business-day idle age is computed deterministically
               (REQ-052) from the deal's own `last_activity_at`, which every
               earlier slice already updates on every state-changing action;
               weekends never count as idle days. `as_of` is an optional,
               injectable "now" (query param on the dashboard, workflow
               input otherwise) purely for testability/demo — never used to
               fabricate a real breach
  * agent   -> the SLA Escalation Briefer's agent_runtime.respond() reply is
               folded in as an advisory `briefing` narrative only, exactly
               like every earlier slice's agent step — never the source of
               a breach determination (the 5-business-day threshold
               comparison below is the only thing that decides is_over_sla)
  * audit   -> the domain audit_trail table, same as every prior slice
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in
               main.py can never shadow them
"""
import datetime
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

SLA_THRESHOLD_BUSINESS_DAYS = 5


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_iso(value):
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _business_days_idle(last_activity_iso, as_of=None):
    """Whole business days elapsed between last_activity_iso and as_of (or
    now). Weekends (Sat/Sun) are never counted — the sla-timers module's
    sla.status() measures elapsed fraction of a fixed SLA window, which is a
    different question from REQ-052's "how many business days has this deal
    sat untouched", so this is a small, deliberately separate calculation."""
    if not last_activity_iso:
        return 0
    start = _parse_iso(last_activity_iso).date()
    now = as_of or datetime.datetime.now(datetime.timezone.utc)
    now_date = now.date() if isinstance(now, datetime.datetime) else now
    if now_date <= start:
        return 0
    count = 0
    d = start
    while d < now_date:
        d += datetime.timedelta(days=1)
        if d.weekday() < 5:  # Mon=0 .. Sun=6
            count += 1
    return count


def _get_deal(deal_id):
    for row in store.list("deals"):
        if row.get("deal_id") == deal_id:
            return row
    return None


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


def _idle_snapshot(as_of=None):
    """Every deal on record, annotated with its own idle age. Returns
    (per_deal dict keyed by deal_id, ordered list of deal_ids)."""
    per_deal = {}
    ids = []
    for deal in store.list("deals"):
        deal_id = deal["deal_id"]
        idle = _business_days_idle(deal.get("last_activity_at"), as_of)
        per_deal[deal_id] = {
            "business_days_idle": idle,
            "is_over_sla": idle > SLA_THRESHOLD_BUSINESS_DAYS,
        }
        ids.append(deal_id)
    return per_deal, ids


# --------------------------------------------------------------------------
# workflow handlers — sla-escalation
# --------------------------------------------------------------------------

def compute_business_days_idle(context):
    inputs = context.get("inputs") or {}
    as_of = None
    if inputs.get("as_of"):
        as_of = _parse_iso(inputs["as_of"])
    per_deal, evaluated_ids = _idle_snapshot(as_of)
    breaching_ids = [d for d in evaluated_ids if per_deal[d]["is_over_sla"]]
    return {
        "evaluated_deal_ids": evaluated_ids,
        "breaching_deal_ids": breaching_ids,
        "breach_count": len(breaching_ids),
        "has_breaches": len(breaching_ids) > 0,
        "computed_at": _now_iso(),
        "per_deal": per_deal,
    }


def flag_sla_breach(context):
    compute = context.get("compute_idle_ages") or {}
    per_deal = compute.get("per_deal") or {}
    now = _now_iso()
    ids = []
    for deal_id in compute.get("breaching_deal_ids", []):
        deal = _get_deal(deal_id)
        info = per_deal.get(deal_id, {})
        row = store.insert(
            "sla_tracking",
            {
                "deal_id": deal_id,
                "stage_entered_at": deal.get("last_activity_at") if deal else None,
                "current_stage": deal.get("current_stage") if deal else None,
                "business_days_idle": info.get("business_days_idle"),
                "is_over_sla": info.get("is_over_sla"),
                "last_updated_at": now,
            },
        )
        ids.append(row["id"])
    system_audit("sla.breach_flagged", {"deal_ids": compute.get("breaching_deal_ids", [])})
    return {"sla_tracking_ids": ids, "breach_count": len(ids), "flagged_at": now}


def apply_sla_escalation_decision(context):
    decision = context.get("escalation_decision") or {}
    per_deal_actions = decision.get("per_deal_actions") or {}
    decided_by_id = decision.get("by") or decision.get("decided_by_id")
    now = _now_iso()
    affected, audit_ids = [], []
    for deal_id, raw_action in per_deal_actions.items():
        deal = _get_deal(deal_id)
        if deal is None:
            continue
        action = raw_action if isinstance(raw_action, dict) else {"action": raw_action}
        act = str(action.get("action") or "acknowledge").lower()
        if act == "reassign":
            new_owner = action.get("assignee") or action.get("reassign_to") or deal.get("assigned_owner_id")
            before = {"assigned_owner_id": deal.get("assigned_owner_id")}
            deal["assigned_owner_id"] = new_owner
            deal["last_activity_at"] = now
            entry = _audit(deal_id, "sla.reassigned", decided_by_id, "human", before=before, after={"assigned_owner_id": new_owner}, description=action.get("reason", ""))
        elif act in ("return_for_rework", "rework"):
            before_stage = deal["current_stage"]
            try:
                deal["current_stage"] = stage_machine.advance(before_stage, "return_for_rework")
            except IllegalTransition as e:
                raise workflow_engine.WorkflowError(str(e))
            deal["last_activity_at"] = now
            entry = _audit(deal_id, "sla.returned_for_rework", decided_by_id, "human", before={"current_stage": before_stage}, after={"current_stage": deal["current_stage"]}, description=action.get("reason", ""))
        else:
            deal["last_activity_at"] = now
            entry = _audit(deal_id, "sla.acknowledged", decided_by_id, "human", after={"acknowledged": True})
        affected.append(deal_id)
        audit_ids.append(entry["id"])
    return {
        "affected_deal_ids": affected,
        "actions_applied": per_deal_actions,
        "decided_by_id": decided_by_id,
        "decided_at": now,
        "audit_entry_ids": audit_ids,
    }


for _name, _fn in [
    ("compute_business_days_idle", compute_business_days_idle),
    ("flag_sla_breach", flag_sla_breach),
    ("apply_sla_escalation_decision", apply_sla_escalation_decision),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface
# --------------------------------------------------------------------------

@router.get("/sla/dashboard")
def sla_dashboard(as_of: str | None = None):
    as_of_dt = None
    if as_of:
        try:
            as_of_dt = _parse_iso(as_of)
        except ValueError:
            raise HTTPException(status_code=400, detail="as_of must be an ISO-8601 timestamp")

    per_deal, evaluated_ids = _idle_snapshot(as_of_dt)
    breaching_ids = [d for d in evaluated_ids if per_deal[d]["is_over_sla"]]

    briefing = ""
    if breaching_ids:
        prompt = (
            f"Deals idle past {SLA_THRESHOLD_BUSINESS_DAYS} business days: {breaching_ids} "
            f"(SLA records {per_deal}). For each, state its current stage, assigned owner, business "
            "days idle and what it is waiting on, using only stored deal and SLA fields. Do not "
            "reassign, advance or decide anything — suggest at most one next action per deal."
        )
        briefing = agent_runtime.respond(prompt, agent_name="SLA Escalation Briefer")
        flag_sla_breach({"compute_idle_ages": {"breaching_deal_ids": breaching_ids, "per_deal": per_deal}})

    deals_view = []
    for deal_id in evaluated_ids:
        deal = _get_deal(deal_id) or {}
        info = per_deal[deal_id]
        deals_view.append(
            {
                "deal_id": deal_id,
                "borrower_name": deal.get("borrower_name"),
                "current_stage": deal.get("current_stage"),
                "status": deal.get("status"),
                "assigned_owner_id": deal.get("assigned_owner_id"),
                "requested_amount": deal.get("requested_amount"),
                "last_activity_at": deal.get("last_activity_at"),
                "business_days_idle": info["business_days_idle"],
                "is_over_sla": info["is_over_sla"],
            }
        )
    deals_view.sort(key=lambda d: (0 if d["is_over_sla"] else 1, -(d["business_days_idle"] or 0)))

    return {
        "as_of": (as_of_dt or datetime.datetime.now(datetime.timezone.utc)).isoformat(),
        "threshold_business_days": SLA_THRESHOLD_BUSINESS_DAYS,
        "evaluated_count": len(evaluated_ids),
        "breach_count": len(breaching_ids),
        "breaching_deal_ids": breaching_ids,
        "deals": deals_view,
        "briefing": briefing,
    }


class EscalationDecisionRequest(BaseModel):
    decided_by_id: str
    per_deal_actions: dict


@router.post("/sla/escalate")
def sla_escalate(req: EscalationDecisionRequest):
    """Applies a credit officer's named per-deal SLA decisions (reassign /
    return_for_rework / acknowledge) — REQ-041/047: the decision and its
    reason/assignee are the officer's, this endpoint only executes it."""
    context = {"escalation_decision": {"decided_by_id": req.decided_by_id, "per_deal_actions": req.per_deal_actions}}
    try:
        result = apply_sla_escalation_decision(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return result
