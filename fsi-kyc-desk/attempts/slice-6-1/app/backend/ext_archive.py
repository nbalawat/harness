"""Slice 6 — case search, audit trail view, CSV export and weekly report.

Nothing here is AI or workflow-engine work: it is a read/export surface over
records the earlier slices already write through db.store. An analyst or
auditor can search past cases, read a case's full chronological audit trail
(already served by slice 4's GET /audit/cases/{reference} in ext_decisions.py
— unchanged here), retrieve the exact score inputs / matrix version /
approved memo text for any past case (the "reproduction" view, REQ-072), and
export a case file (including its trail) or the weekly breached-SLA report as
CSV, so retained records stay reviewable and reproducible for internal audit
and regulators.

GET /export/cases.csv is deliberately NOT reimplemented here: the composed
export-csv module's generic GET /export/{table}.csv already serves it (the
`cases` table carries case_reference/client_name/risk_band/status per
models.TABLES), so a case-list export needs no new code — see SLICES.md.

Composition contract:
  * storage -> db.store only (reads cases, case_cycles, documents,
               risk_scores, assessment_memos, audit_trail, sla_tracking,
               escalations; writes only a `case_file_exported` audit_trail
               row when a per-case CSV is downloaded)
  * audit   -> ext_audit.record + audit_trail, via ext_cases.audit
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in main.py
               can never shadow them; each new path template has either an
               extra segment (/export/cases/{reference}.csv,
               /cases/{reference}/reproduction) or a distinct first segment
               (/search/cases, /reports/weekly-operations) from every route
               registered by earlier slices, so there is no ordering conflict
               regardless of import order.
"""
import csv
import io

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import PlainTextResponse

import kyc_policy as policy
from db import store
from ext_cases import acting_user as resolve_actor
from ext_cases import audit, case_summary, cycle_row, documents_for, find_case

router = APIRouter()


# --------------------------------------------------------------------------
# Storage helpers
# --------------------------------------------------------------------------
def _score_row_for(case_id, cycle):
    matches = [r for r in store.list("risk_scores") if r["case_id"] == case_id and r.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


def _memos_for(case_id, cycle=None):
    memos = [m for m in store.list("assessment_memos") if m["case_id"] == case_id]
    if cycle is not None:
        memos = [m for m in memos if m.get("cycle", 1) == cycle]
    memos.sort(key=lambda m: (m.get("cycle", 1), m["version"]))
    return memos


def _audit_for(case_id):
    entries = [e for e in store.list("audit_trail") if e["case_id"] == case_id]
    entries.sort(key=lambda e: e["id"])
    return entries


def _latest_tracking_for_case(case_id):
    matches = [t for t in store.list("sla_tracking") if t["case_id"] == case_id]
    return matches[-1] if matches else None


def _breach_tracking_for_case(case_id):
    """The sla_tracking row that actually recorded the breach — not just the
    newest cycle's row. A resubmission after a breach starts a fresh,
    unbreached tracking row for the new cycle (a new cycle's clock has not
    breached yet), but the permanent `cases.sla_breached` flag (REQ-053)
    survives the resubmission untouched. Reading `breached_at`/the recorded
    reporting period off the newest-but-unbreached row would silently report
    a permanently-breached case as if it had no breach timestamp at all.
    """
    matches = [t for t in store.list("sla_tracking") if t["case_id"] == case_id and t.get("breached")]
    return matches[-1] if matches else _latest_tracking_for_case(case_id)


def _period_of(iso_timestamp):
    """The ISO week label (matching kyc_policy's own `%Y-W%V` stamps) a
    timestamp falls in, or None if it can't be parsed."""
    if not iso_timestamp:
        return None
    import datetime

    try:
        parsed = datetime.datetime.fromisoformat(str(iso_timestamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.strftime("%Y-W%V")


def _escalations_for(case_id):
    return sorted((e for e in store.list("escalations") if e["case_id"] == case_id), key=lambda e: e["id"])


# --------------------------------------------------------------------------
# GET /search/cases — find past cases by identifier/client or filter by band
# --------------------------------------------------------------------------
@router.get("/search/cases")
def search_cases(q: str = "", risk_band: str | None = None, status: str | None = None):
    """Every case ever opened, findable by identifier/client, band or status."""
    rows = store.list("cases")
    needle = q.strip().lower()
    if needle:
        rows = [
            r
            for r in rows
            if needle in str(r.get("case_reference") or "").lower()
            or needle in str(r.get("client_reference") or "").lower()
            or needle in str(r.get("client_name_normalized") or "").lower()
            or needle in str(r.get("client_name") or "").lower()
        ]
    if risk_band:
        rows = [r for r in rows if str(r.get("risk_band") or "").lower() == risk_band.strip().lower()]
    if status:
        rows = [r for r in rows if str(r.get("status") or "").lower() == status.strip().lower()]
    return {
        "query": q,
        "risk_band": risk_band,
        "status": status,
        "count": len(rows),
        "results": [case_summary(r) for r in rows],
    }


# --------------------------------------------------------------------------
# GET /cases/{reference}/reproduction — exact score inputs, matrix version
# and approved memo text for any past case (REQ-072)
# --------------------------------------------------------------------------
@router.get("/cases/{reference}/reproduction")
def case_reproduction(reference: str):
    """Reproduce a case's outcome exactly: the versions and inputs that applied.

    Reads the CURRENT cycle's own case_cycles snapshot (never the mutated case
    row alone), so a case that was decided and later resubmitted still
    reproduces the cycle actually asked for rather than a later cycle's
    overwritten values — per SLICES.md's slice-1 note (d)/(f)/(g).
    """
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    cycle = row.get("cycle", 1)
    snapshot = cycle_row(row["id"], cycle) or {}
    score_row = _score_row_for(row["id"], cycle) or {}
    memos = _memos_for(row["id"], cycle)
    approved_memo = next((m for m in memos if m.get("is_approved")), None)
    memo = approved_memo or (memos[-1] if memos else None)
    return {
        "case_reference": row["case_reference"],
        "client_name": row.get("client_name"),
        "cycle": cycle,
        "document_checklist_version": snapshot.get("document_checklist_version") or row.get("document_checklist_version"),
        "risk_matrix_version": snapshot.get("risk_matrix_version") or row.get("risk_matrix_version"),
        "onboarding_policy_version": snapshot.get("onboarding_policy_version") or row.get("onboarding_policy_version"),
        "attributes": snapshot.get("attributes") or row.get("attributes") or {},
        "risk_factors": snapshot.get("risk_factors") or row.get("risk_factors") or {},
        "submitted_documents": snapshot.get("submitted_documents") or row.get("submitted_documents") or [],
        "factor_breakdown": score_row.get("factor_breakdown") or [],
        "factor_weights": score_row.get("factor_weights") or {},
        "factor_contributions": score_row.get("factor_contributions") or {},
        "total_risk_score": score_row.get("total_risk_score", row.get("total_risk_score")),
        "risk_band": score_row.get("risk_band", row.get("risk_band")),
        "sanctions_true_positive_override_applied": score_row.get("sanctions_true_positive_override_applied"),
        "status": snapshot.get("status") or row.get("status"),
        "decision": snapshot.get("decision"),
        "decided_at": snapshot.get("decided_at"),
        "decided_by_user_id": snapshot.get("decided_by_user_id"),
        "decided_by_role": snapshot.get("decided_by_role"),
        "memo_version": (memo or {}).get("version"),
        "memo_text": (memo or {}).get("memo_text"),
        "is_machine_drafted": (memo or {}).get("is_machine_drafted"),
        "is_approved_memo": (memo or {}).get("is_approved"),
        "policy_citations": (memo or {}).get("policy_citations") or [],
    }


# --------------------------------------------------------------------------
# GET /export/cases/{reference}.csv?include=audit_trail — a case file whole
# --------------------------------------------------------------------------
@router.get("/export/cases/{reference}.csv")
def export_case_file(
    reference: str,
    include: str = "",
    acting_user: str = "",
    authorization: str | None = Header(default=None),
):
    """One CSV per case: particulars, checklist, factor table, every memo
    version (with its citations and the permanent machine-drafted label) and,
    when `include=audit_trail`, the complete chronological register with
    before/after values — matching the design's own "export carries ... the
    complete audit register — one row per record, one file per case" promise.

    The export is itself logged (requesting user and case identifier named),
    same as every other state-touching action on this desk.
    """
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    include_set = {p.strip().lower() for p in (include or "").split(",") if p.strip()}
    cycle = row.get("cycle", 1)

    records = [
        {
            "record_type": "case",
            "case_reference": row["case_reference"],
            "client_name": row.get("client_name"),
            "entity_type": row.get("entity_type"),
            "status": row.get("status"),
            "risk_band": row.get("risk_band"),
            "total_risk_score": row.get("total_risk_score"),
            "cycle": cycle,
            "document_checklist_version": row.get("document_checklist_version"),
            "risk_matrix_version": row.get("risk_matrix_version"),
            "onboarding_policy_version": row.get("onboarding_policy_version"),
            "sla_due_timestamp": row.get("sla_due_timestamp"),
            "sla_breached": row.get("sla_breached"),
            "next_review_due_date": row.get("next_review_due_date"),
        }
    ]
    for d in documents_for(row["id"]):
        records.append(
            {
                "record_type": "checklist_item",
                "case_reference": row["case_reference"],
                "document_type": d["document_type"],
                "required": d["required"],
                "conditionally_required": d["conditionally_required"],
                "received": d["received"],
            }
        )
    score_row = _score_row_for(row["id"], cycle)
    if score_row:
        for f in score_row.get("factor_breakdown") or []:
            records.append(
                {
                    "record_type": "risk_factor",
                    "case_reference": row["case_reference"],
                    "factor": f.get("factor"),
                    "raw_input": f.get("raw_input"),
                    "factor_score": f.get("factor_score"),
                    "weight": f.get("weight"),
                    "contribution": f.get("contribution"),
                }
            )
    for m in _memos_for(row["id"]):
        records.append(
            {
                "record_type": "memo",
                "case_reference": row["case_reference"],
                "version": m.get("version"),
                "cycle": m.get("cycle"),
                "is_machine_drafted": m.get("is_machine_drafted"),
                "is_approved": m.get("is_approved"),
                "generated_at": m.get("generated_at"),
                "memo_text": m.get("memo_text"),
            }
        )
    if "audit_trail" in include_set:
        for e in _audit_for(row["id"]):
            records.append(
                {
                    "record_type": "audit_entry",
                    "case_reference": row["case_reference"],
                    "action_type": e.get("action_type"),
                    "performed_by_user_id": e.get("performed_by_user_id"),
                    "performed_by_role": e.get("performed_by_role"),
                    "timestamp": e.get("timestamp"),
                    "field_name": e.get("field_name"),
                    "old_value": e.get("old_value"),
                    "new_value": e.get("new_value"),
                }
            )

    fieldnames, seen = [], set()
    for r in records:
        for key in r:
            if key not in seen:
                seen.add(key)
                fieldnames.append(key)
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for r in records:
        writer.writerow(r)

    who = resolve_actor(authorization, acting_user) or "unknown"
    audit(
        row["id"],
        "case_file_exported",
        who,
        field_name="export",
        old_value=None,
        new_value="csv",
        details={"case_reference": row["case_reference"], "include": sorted(include_set), "row_count": len(records)},
    )
    return PlainTextResponse(out.getvalue(), media_type="text/csv")


# --------------------------------------------------------------------------
# GET /reports/weekly-operations — breached SLAs, generated from the register
# --------------------------------------------------------------------------
@router.get("/reports/weekly-operations")
def weekly_operations_report():
    """The current reporting week's breached SLAs, generated from the register alone.

    Scoped to the ISO week containing "now" (kyc_policy.now_utc()) — the same
    week label ext_sla.py's `record_sla_breach` stamps onto `sla_tracking`'s
    private `_breach_weekly_report_period` field the moment a case breaches,
    so this report and that stamp never disagree on which week a breach
    belongs to. The top-level `period` is computed directly from the clock,
    never inferred from whichever case happens to sort first. A permanently
    breached case (REQ-053) whose breach happened in an earlier week is not
    repeated in every later week's report — its full history is still always
    available via GET /search/cases or the case's own /reproduction.
    """
    current_period = policy.now_utc().strftime("%Y-W%V")

    breached_cases = []
    for row in store.list("cases"):
        if not row.get("sla_breached"):
            continue
        tracking = _breach_tracking_for_case(row["id"])
        case_period = (
            (tracking or {}).get("_breach_weekly_report_period")
            or _period_of((tracking or {}).get("breached_at"))
            or current_period
        )
        if case_period != current_period:
            continue
        escalations = _escalations_for(row["id"])
        breached_cases.append(
            {
                "case_reference": row["case_reference"],
                "client_name": row.get("client_name"),
                "risk_band": row.get("risk_band"),
                "status": row.get("status"),
                "breached": True,
                "breached_at": (tracking or {}).get("breached_at"),
                "sla_hours": row.get("sla_hours"),
                "assigned_approver_id": row.get("assigned_approver_id"),
                "escalation_level": max((e["escalation_level"] for e in escalations), default=0),
                "period": case_period,
            }
        )
    breached_cases.sort(key=lambda c: c["case_reference"])

    decided_this_period = len(
        [a for a in store.list("approvals") if _period_of(a.get("decided_at")) == current_period]
    )
    escalations_this_period = len(
        [e for e in store.list("escalations") if _period_of(e.get("escalated_at")) == current_period]
    )
    return {
        "period": current_period,
        "generated_at": policy.iso(policy.now_utc()),
        "cases_decided_count": decided_this_period,
        "breached_count": len(breached_cases),
        "breached_cases": breached_cases,
        "escalations_count": escalations_this_period,
    }
