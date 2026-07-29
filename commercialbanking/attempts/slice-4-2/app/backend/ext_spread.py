"""spread-ratios-grade slice.

Implements the second portion of the approved `deal-underwriting` workflow
(workflows/workflows.json): spread_financials (agent) -> persist_spread_draft
-> [review_spread: human] -> apply_spread_decision -> check_spread_accepted
-> compute_ratios -> assign_risk_grade. The four deterministic/agent-adjacent
nodes are registered as real workflow_engine handlers under the exact names
the workflow definition calls out, so driving the generic engine also runs
this slice's portion end to end.

The REST surface below (/deals/{id}/spread/run, /deals/{id}/spread/accept,
/deals/{id}/ratios, /deals/{id}/risk-grade) calls those SAME handler
functions with a hand-built context, for the same reason ext_deals.py does:
the acceptance contract needs distinct human-facing steps (propose -> human
reviews beside source -> accept/edit) rather than the one-shot chain the
generic engine would run straight through.

Composition contract:
  * storage  -> db.store only (spread_line_items, credit_ratios, risk_grades,
                audit_trail)
  * files    -> every source figure is read back through blob_store, never
                open()'d from a request-derived path
  * parsing  -> spreadsheet_io.read_rows() (spreadsheet-io module) coerces the
                borrower's CSV export; nothing here hand-rolls a CSV parser
  * process  -> deal_state.machine owns the financial_spreading ->
                credit_memo_review transition
  * agent    -> agent_runtime.respond() carries the Financial Spreading
                Agent's narrative only. Every line item's value, source
                document, location and raw text are derived deterministically
                from the deal's own stored spreadsheet artifact — matching
                the citation/provenance pattern used by the intake triage
                slice: the model's reply is advisory rationale, never the
                source of a figure.
  * ratios   -> computed by fixed formulas over the human-accepted spread
                only (REQ-014), each stored with its formula string and
                numeric inputs so it is independently reproducible (REQ-016)
  * grade    -> assigned by a fixed, ordered rubric table (REQ-015, REQ-017);
                the exact rule text applied is stored and returned verbatim,
                never paraphrased by a model
  * audit    -> the domain audit_trail table, same as the intake slice
  * routes   -> mounted outside /api/ so the /api/{table} catch-all in
                main.py can never shadow them
"""
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import agent_runtime
import blob_store
import spread_template
import spreadsheet_io
import workflow_engine
from db import store
from deal_state import machine as stage_machine
from ext_audit import record as system_audit
from statemachine import IllegalTransition

router = APIRouter()

SPREAD_ARTIFACT_TYPES = {"spreadsheet", "financial_statement"}

# Fixed, inspectable risk-grade rubric (REQ-015, REQ-016, REQ-017). Evaluated
# in order; the first fully-satisfied rule wins. Never edited by an agent.
RUBRIC_VERSION = "v1"
RISK_GRADE_RUBRIC = [
    {
        "grade": 1,
        "min_dscr": 1.50,
        "max_leverage": 2.50,
        "min_current_ratio": 1.50,
        "description": "Grade 1: DSCR >= 1.50x, leverage <= 2.50x, current ratio >= 1.50",
    },
    {
        "grade": 2,
        "min_dscr": 1.25,
        "max_leverage": 3.50,
        "min_current_ratio": 1.20,
        "description": "Grade 2: DSCR >= 1.25x, leverage <= 3.50x, current ratio >= 1.20",
    },
    {
        "grade": 3,
        "min_dscr": 1.10,
        "max_leverage": 4.50,
        "min_current_ratio": 1.00,
        "description": "Grade 3: DSCR >= 1.10x, leverage <= 4.50x, current ratio >= 1.00",
    },
    {
        "grade": 4,
        "min_dscr": 1.00,
        "max_leverage": 5.50,
        "min_current_ratio": 0.0,
        "description": "Grade 4: DSCR >= 1.00x, leverage <= 5.50x",
    },
]
FALLBACK_GRADE = {
    "grade": 5,
    "description": "Grade 5: fails every Grade 4 threshold (DSCR < 1.00x or leverage > 5.50x)",
}


def _select_grade(dscr, leverage, current_ratio):
    for rule in RISK_GRADE_RUBRIC:
        dscr_ok = dscr is not None and dscr >= rule["min_dscr"]
        leverage_ok = leverage is not None and leverage <= rule["max_leverage"]
        cr_ok = current_ratio is not None and current_ratio >= rule["min_current_ratio"]
        if dscr_ok and leverage_ok and cr_ok:
            return rule["grade"], rule["description"]
    return FALLBACK_GRADE["grade"], FALLBACK_GRADE["description"]


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


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


def _artifacts_for(deal_id):
    return [a for a in store.list("source_artifacts") if a["deal_id"] == deal_id]


def _pending_spread_rows(deal_id):
    return [r for r in store.list("spread_line_items") if r["deal_id"] == deal_id and r.get("accepted_value") is None]


def _accepted_spread_map(deal_id):
    m = {}
    for r in store.list("spread_line_items"):
        if r["deal_id"] == deal_id and r.get("accepted_value") is not None:
            m[r["line_item_key"]] = r["accepted_value"]
    return m


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

def persist_spread_draft(context):
    record = context.get("record_intake") or {}
    deal_id = record.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to spread")

    found_keys = set()
    line_items = []
    now = _now_iso()
    for artifact in _artifacts_for(deal_id):
        if artifact.get("artifact_type") not in SPREAD_ARTIFACT_TYPES:
            continue
        try:
            raw_text = blob_store.get(artifact["file_path"]).decode("utf-8", errors="replace")
        except FileNotFoundError:
            continue
        rows = spreadsheet_io.read_rows(raw_text)
        raw_lines = raw_text.splitlines()
        data_lines = raw_lines[1:] if raw_lines else []
        for idx, row in enumerate(rows):
            key = str(row.get("line_item") or "").strip().lower().replace(" ", "_")
            if key not in spread_template.TEMPLATE_KEYS or key in found_keys:
                continue
            value = row.get("amount")
            try:
                numeric_value = float(value)
            except (TypeError, ValueError):
                continue
            raw_line = data_lines[idx].strip() if idx < len(data_lines) else f"{row}"
            found_keys.add(key)
            stored_row = store.insert(
                "spread_line_items",
                {
                    "deal_id": deal_id,
                    "line_item_key": key,
                    "line_item_label": spread_template.TEMPLATE_LABELS[key],
                    "extracted_value": numeric_value,
                    "accepted_value": None,
                    "source_document_id": artifact["id"],
                    "source_location": f"{artifact['file_name']}: row {idx + 2}",
                    "raw_extracted_text": raw_line,
                    "created_at": now,
                    "accepted_at": None,
                    "accepted_by_id": None,
                },
            )
            line_items.append(stored_row)

    unextractable = [k for k in spread_template.TEMPLATE_KEYS if k not in found_keys]
    agent_reply = (context.get("spread_financials") or {}).get("reply", "")
    rationale = (
        f"Extracted {len(line_items)} of {len(spread_template.TEMPLATE_KEYS)} template line item(s) from "
        f"deal {deal_id}'s stored spreadsheet artifact(s)."
        + (f" Unextractable: {', '.join(unextractable)}." if unextractable else " Template fully covered.")
        + f" Agent notes: {agent_reply}"
    )
    entry = _audit(
        deal_id,
        "spread.drafted",
        "financial-spreading-agent",
        "agent",
        after={"spread_line_item_ids": [r["id"] for r in line_items], "unextractable": unextractable},
        description=rationale,
    )
    return {
        "deal_id": deal_id,
        "spread_line_item_ids": [r["id"] for r in line_items],
        "line_items": line_items,
        "unextractable_line_item_keys": unextractable,
        "draft_status": "pending",
        "provenance_complete": len(unextractable) == 0,
        "rationale": rationale,
        "audit_entry_id": entry["id"],
    }


def apply_spread_review_decision(context):
    record = context.get("record_intake") or {}
    draft = context.get("persist_spread_draft") or {}
    deal_id = record.get("deal_id") or draft.get("deal_id")
    deal = _get_deal(deal_id)
    if deal is None:
        raise workflow_engine.WorkflowError(f"no deal '{deal_id}' to decide spread for")

    decision_details = context.get("decision_details") or {}
    if decision_details:
        decision = (decision_details.get("decision") or "accept").lower()
        accepted_by_id = decision_details.get("accepted_by_id")
        edits = decision_details.get("edits") or []
    else:
        review = context.get("review_spread") or {}
        decision = "accept" if review.get("approved") else "return_for_rework"
        accepted_by_id = review.get("by")
        edits = []

    edit_map = {e["line_item_id"]: e["accepted_value"] for e in edits if "line_item_id" in e and "accepted_value" in e}
    pending_rows = _pending_spread_rows(deal_id)
    if not pending_rows:
        raise workflow_engine.WorkflowError(f"no pending spread line items for deal '{deal_id}'")

    status = "accepted" if decision == "accept" else "returned_for_rework"
    now = _now_iso()
    accepted_ids = []
    if status == "accepted":
        for row in pending_rows:
            row["accepted_value"] = edit_map.get(row["id"], row["extracted_value"])
            row["accepted_at"] = now
            row["accepted_by_id"] = accepted_by_id
            accepted_ids.append(row["id"])

    _audit(
        deal_id,
        f"spread.{status}",
        accepted_by_id,
        "human",
        before={"pending_count": len(pending_rows)},
        after={"accepted_line_item_ids": accepted_ids},
        description=f"Financial spread {status} by {accepted_by_id} ({len(accepted_ids)} line item(s)).",
    )

    if status == "accepted":
        previous_stage = deal["current_stage"]
        try:
            new_stage = stage_machine.advance(previous_stage, "accept_spread")
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
            description=f"Deal advanced to '{new_stage}' after spread acceptance.",
        )

    return {
        "deal_id": deal_id,
        "spread_status": status,
        "accepted_line_item_ids": accepted_ids,
        "accepted_by_id": accepted_by_id,
        "accepted_at": now,
        "current_stage": deal["current_stage"],
    }


def compute_credit_ratios(context):
    decision = context.get("apply_spread_decision") or {}
    deal_id = decision.get("deal_id") or (context.get("record_intake") or {}).get("deal_id")
    if deal_id is None:
        raise workflow_engine.WorkflowError("no deal_id available to compute ratios for")

    accepted = _accepted_spread_map(deal_id)
    ebitda = accepted.get("ebitda")
    ads = accepted.get("annual_debt_service")
    total_debt = accepted.get("total_debt")
    current_assets = accepted.get("current_assets")
    current_liabilities = accepted.get("current_liabilities")

    dscr = ebitda / ads if ebitda is not None and ads else None
    leverage = total_debt / ebitda if total_debt is not None and ebitda else None
    current_ratio = current_assets / current_liabilities if current_assets is not None and current_liabilities else None

    ratio_defs = [
        ("dscr", dscr, "ebitda / annual_debt_service", {"ebitda": ebitda, "annual_debt_service": ads}),
        ("leverage", leverage, "total_debt / ebitda", {"total_debt": total_debt, "ebitda": ebitda}),
        (
            "current_ratio",
            current_ratio,
            "current_assets / current_liabilities",
            {"current_assets": current_assets, "current_liabilities": current_liabilities},
        ),
    ]
    now = _now_iso()
    formulas = {}
    inputs = {}
    for ratio_type, value, formula, ratio_inputs in ratio_defs:
        store.insert(
            "credit_ratios",
            {
                "deal_id": deal_id,
                "ratio_type": ratio_type,
                "computed_value": value,
                "formula": formula,
                "inputs": ratio_inputs,
                "computed_at": now,
            },
        )
        formulas[ratio_type] = formula
        inputs[ratio_type] = ratio_inputs

    _audit(
        deal_id,
        "ratios.computed",
        "ratio-engine",
        "system",
        after={"dscr": dscr, "leverage": leverage, "current_ratio": current_ratio},
        description=f"Computed DSCR={dscr}, leverage={leverage}, current ratio={current_ratio} from the accepted spread.",
    )
    return {
        "deal_id": deal_id,
        "dscr": dscr,
        "leverage": leverage,
        "current_ratio": current_ratio,
        "formulas": formulas,
        "inputs": inputs,
    }


def assign_risk_grade(context):
    ratios = context.get("compute_ratios") or {}
    deal_id = ratios.get("deal_id") or (context.get("apply_spread_decision") or {}).get("deal_id")
    if deal_id is None:
        raise workflow_engine.WorkflowError("no deal_id available to assign a risk grade for")

    dscr = ratios.get("dscr")
    leverage = ratios.get("leverage")
    current_ratio = ratios.get("current_ratio")
    grade, rule_applied = _select_grade(dscr, leverage, current_ratio)
    inputs = {"dscr": dscr, "leverage": leverage, "current_ratio": current_ratio}
    now = _now_iso()
    # Note: rubric_version is NOT persisted as a risk_grades column — that
    # table's schema comes verbatim from the approved data model
    # (models.py, "do not hand-edit") and doesn't declare one. Since only one
    # rubric version is ever live in code at a time, RUBRIC_VERSION is a
    # constant the API layer attaches on read instead of a stored column.
    store.insert(
        "risk_grades",
        {
            "deal_id": deal_id,
            "grade": grade,
            "rubric_rule_applied": rule_applied,
            "inputs": inputs,
            "computed_at": now,
        },
    )
    _audit(
        deal_id,
        "risk_grade.assigned",
        "risk-grade-rubric",
        "system",
        after={"grade": grade, "rule": rule_applied},
        description=f"Assigned risk grade {grade} — {rule_applied}.",
    )
    return {
        "deal_id": deal_id,
        "grade": grade,
        "rubric_rule_applied": rule_applied,
        "inputs": inputs,
        "rubric_version": RUBRIC_VERSION,
    }


for _name, _fn in [
    ("persist_spread_draft", persist_spread_draft),
    ("apply_spread_review_decision", apply_spread_review_decision),
    ("compute_credit_ratios", compute_credit_ratios),
    ("assign_risk_grade", assign_risk_grade),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# API surface — routes live outside /api/ so main.py's /api/{table} catch-all
# never shadows them.
# --------------------------------------------------------------------------

class SpreadEdit(BaseModel):
    line_item_id: int
    accepted_value: float


class SpreadAcceptRequest(BaseModel):
    decision: str = "accept"
    accepted_by_id: str
    edits: list[SpreadEdit] = []


@router.post("/deals/{deal_id}/spread/run")
def spread_run(deal_id: str):
    deal = _get_deal_or_404(deal_id)
    artifact_ids = [a["id"] for a in _artifacts_for(deal_id)]
    context = {
        "record_intake": {
            "deal_id": deal_id,
            "borrower_name": deal.get("borrower_name"),
            "stored_artifact_ids": artifact_ids,
        }
    }
    prompt = (
        f"You are the financial spreading agent for deal {deal_id} (borrower {deal.get('borrower_name')}). "
        f"Extract every line item of the standard spread template from the borrower financial statements in "
        f"artifacts {artifact_ids}. For every figure, attach the source document id, its location, and the raw "
        "extracted text. Never infer, average or invent a figure not present in a source document — leave it "
        "null and say so. Do not compute ratios, assign a grade, or write a memo. Return a proposal only; a "
        "human reviewer will accept or edit each figure."
    )
    context["spread_financials"] = {"reply": agent_runtime.respond(prompt, agent_name="Financial Spreading Agent")}
    try:
        result = persist_spread_draft(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "deal_id": deal_id,
        "line_items": result["line_items"],
        "unextractable_line_item_keys": result["unextractable_line_item_keys"],
        "draft_status": result["draft_status"],
        "provenance_complete": result["provenance_complete"],
        "rationale": result["rationale"],
    }


@router.post("/deals/{deal_id}/spread/accept")
def spread_accept(deal_id: str, req: SpreadAcceptRequest):
    _get_deal_or_404(deal_id)
    if not _pending_spread_rows(deal_id):
        raise HTTPException(status_code=400, detail="no pending spread proposal for this deal")
    context = {
        "record_intake": {"deal_id": deal_id},
        "decision_details": {
            "decision": req.decision,
            "accepted_by_id": req.accepted_by_id,
            "edits": [e.model_dump() for e in req.edits],
        },
    }
    try:
        decision_result = apply_spread_review_decision(context)
    except workflow_engine.WorkflowError as e:
        raise HTTPException(status_code=409, detail=str(e))

    response = {
        "deal_id": deal_id,
        "accepted": decision_result["spread_status"] == "accepted",
        "spread_status": decision_result["spread_status"],
        "accepted_line_item_ids": decision_result["accepted_line_item_ids"],
        "accepted_by_id": decision_result["accepted_by_id"],
        "current_stage": decision_result["current_stage"],
    }
    if decision_result["spread_status"] == "accepted":
        ratios_context = dict(context)
        ratios_context["apply_spread_decision"] = decision_result
        ratios_result = compute_credit_ratios(ratios_context)
        grade_context = dict(ratios_context)
        grade_context["compute_ratios"] = ratios_result
        grade_result = assign_risk_grade(grade_context)
        response["ratios"] = ratios_result
        response["risk_grade"] = grade_result
    return response


@router.get("/deals/{deal_id}/ratios")
def get_ratios(deal_id: str):
    _get_deal_or_404(deal_id)
    latest = {}
    for row in store.list("credit_ratios"):
        if row["deal_id"] == deal_id:
            latest[row["ratio_type"]] = row
    if not latest:
        raise HTTPException(status_code=404, detail="ratios not yet computed for this deal")
    return {
        "deal_id": deal_id,
        "dscr": (latest.get("dscr") or {}).get("computed_value"),
        "leverage": (latest.get("leverage") or {}).get("computed_value"),
        "current_ratio": (latest.get("current_ratio") or {}).get("computed_value"),
        "ratios": [
            {
                "ratio_type": ratio_type,
                "computed_value": row["computed_value"],
                "formula": row["formula"],
                "inputs": row["inputs"],
                "computed_at": row["computed_at"],
            }
            for ratio_type, row in latest.items()
        ],
    }


@router.get("/deals/{deal_id}/risk-grade")
def get_risk_grade(deal_id: str):
    _get_deal_or_404(deal_id)
    rows = [r for r in store.list("risk_grades") if r["deal_id"] == deal_id]
    if not rows:
        raise HTTPException(status_code=404, detail="risk grade not yet assigned for this deal")
    latest = rows[-1]
    return {
        "deal_id": deal_id,
        "grade": latest["grade"],
        "rubric_rule_applied": latest["rubric_rule_applied"],
        "inputs": latest["inputs"],
        "rubric_version": RUBRIC_VERSION,
        "computed_at": latest["computed_at"],
    }


@router.get("/spread-template")
def get_spread_template():
    return spread_template.describe()
