"""Slice 3 — AI-drafted risk assessment memo with citations.

The Risk Assessment Memo Assistant (agents/roster.json) drafts the case memo
through the approved `risk-memo-and-approval` workflow (workflows/workflows.json):
load the case's own record and the versioned policy corpus, draft (an `agent`
node — reasoning goes through agent_runtime.respond, never a direct provider
call), persist an immutable machine-drafted version, and mechanically check
that every citation resolves back to a named provision. The workflow then
parks at its human `approval_decision` node — deciding that belongs to slice 4
(rbac-tiered-approval); this module never touches case status, score, or
approval (REQ-034/REQ-036/REQ-037/REQ-038).

Composition contract:
  * storage -> db.store only (`assessment_memos`; reads `cases`/`risk_scores`/`documents`)
  * process -> workflow_engine, running workflows.json's `risk-memo-and-approval`
               verbatim up to its first human node
  * agent   -> agent_runtime.respond via the workflow's `agent` node — never a
               provider SDK call directly
  * audit   -> ext_audit.record + audit_trail, via ext_cases.audit
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in main.py
               can never shadow them
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import kyc_policy as policy
import workflow_engine
from db import store
from ext_cases import acting_user, audit, case_by_id, find_case

router = APIRouter()

MEMO_TABLE = "assessment_memos"


def _latest_score_row(case_id, cycle):
    matches = [r for r in store.list("risk_scores") if r["case_id"] == case_id and r.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


# --------------------------------------------------------------------------
# Workflow handlers — the implementation contract of risk-memo-and-approval
# --------------------------------------------------------------------------
def load_case_for_assessment(context):
    """Ground the drafting agent in the case's own record — nothing else.

    Everything the agent node's prompt interpolates comes out of this single
    handler, so the memo can never be grounded in anything the case record
    and the versioned policy corpus don't already say (REQ-030).
    """
    inputs = context.get("inputs") or {}
    row = find_case(inputs.get("case_reference"))
    if row is None:
        raise workflow_engine.WorkflowError(f"no case with reference '{inputs.get('case_reference')}'")
    if row.get("total_risk_score") is None:
        raise workflow_engine.WorkflowError("case has not passed completeness and scoring yet — nothing to assess")
    cycle = row.get("cycle", 1)
    score_row = _latest_score_row(row["id"], cycle) or {}
    attributes = row.get("attributes") or {}
    risk_factors = row.get("risk_factors") or {}
    checklist_docs = {
        d["document_type"]: d
        for d in store.list("documents")
        if d["case_id"] == row["id"] and d.get("cycle", 1) == cycle
    }
    bo_doc = checklist_docs.get("beneficial_ownership_declaration")
    bo_received = bool(bo_doc and bo_doc.get("received"))
    beneficial_ownership_summary = (
        f"Ownership chain depth recorded as {attributes.get('ownership_chain_depth', 'not recorded')}; entity "
        f"structure classified '{risk_factors.get('entity_structure', 'not recorded')}'; beneficial ownership "
        "declaration " + ("received and on file." if bo_received else "not recorded as received on this cycle.")
    )
    jurisdiction_exposure = (
        f"Jurisdiction factor recorded as '{risk_factors.get('jurisdiction', 'not recorded')}', scoring "
        f"{score_row.get('jurisdiction_factor_score', 'not recorded')} of 100 before weighting."
    )
    override_applied = bool(score_row.get("sanctions_true_positive_override_applied"))
    sanctions_screening_result = f"Sanctions screening recorded as '{risk_factors.get('sanctions_screening', 'not recorded')}'" + (
        " — a confirmed true positive, which forces the High band regardless of the weighted total."
        if override_applied
        else "."
    )
    versions = {
        "document_checklist_version": row.get("document_checklist_version"),
        "risk_matrix_version": row.get("risk_matrix_version"),
        "onboarding_policy_version": row.get("onboarding_policy_version"),
        "escalation_sla_policy_version": policy.SLA_POLICY_VERSION,
    }
    return {
        "case_id": row["id"],
        "case_reference": row["case_reference"],
        "client_name": row.get("client_name"),
        "status": row.get("status"),
        "cycle": cycle,
        "beneficial_ownership_summary": beneficial_ownership_summary,
        "jurisdiction_exposure": jurisdiction_exposure,
        "sanctions_screening_result": sanctions_screening_result,
        "sanctions_true_positive_override_applied": override_applied,
        "factor_breakdown": score_row.get("factor_breakdown") or [],
        "total_risk_score": row.get("total_risk_score"),
        "risk_band": row.get("risk_band"),
        "required_approver_role": policy.required_approver_role(row.get("risk_band")),
        "policy_versions": versions,
        "policy_corpus_refs": [d["id"] for d in policy.POLICY_CORPUS],
    }


def _build_citations(loaded):
    """Deterministic citations for this case — resolvable through the same
    kyc_policy.resolve_citation() that backs GET /citations/resolve, so an
    auditor checking either path gets the same answer (REQ-032)."""
    refs = [
        ("risk-rating-matrix", "jurisdiction"),
        ("risk-rating-matrix", "sanctions_screening"),
        ("document-checklist", "beneficial_ownership_declaration"),
        ("kyc-onboarding-policy", "approval_routing"),
    ]
    if loaded.get("sanctions_true_positive_override_applied"):
        refs.append(("kyc-onboarding-policy", "sanctions_override"))
    return [policy.resolve_citation(doc, sec) for doc, sec in refs]


def _memo_text(loaded, citations, agent_reply, version):
    band_title = policy.band_label(loaded.get("risk_band"))
    matrix_version = (loaded.get("policy_versions") or {}).get("risk_matrix_version")
    lines = [
        "MACHINE-DRAFTED — REQUIRES HUMAN APPROVAL",
        "(machine-drafted; advisory only; not a decision)",
        "",
        f"Risk Assessment Memorandum — {loaded.get('case_reference')} "
        f"({loaded.get('client_name') or 'unnamed client'}) — version {version}",
        "",
        f"Beneficial ownership [1]: {loaded.get('beneficial_ownership_summary')}",
        f"Jurisdiction exposure [2]: {loaded.get('jurisdiction_exposure')}",
        f"Sanctions screening [3]: {loaded.get('sanctions_screening_result')}",
        (
            f"Computed score and band [4]: total {loaded.get('total_risk_score')} of 100, band {band_title}, "
            f"risk rating matrix v{matrix_version}; requires a {loaded.get('required_approver_role')} decision."
        ),
        "",
        "Drafting agent notes:",
        agent_reply or "(the drafting agent returned no additional narrative for this version)",
        "",
        "This is a machine-drafted memorandum: it records no case status change, no score adjustment, and no "
        "approval or rejection. A named human approver at the required tier must review and adopt it before it "
        "has any effect on the case. Any fact not present in the case record or the cited policy documents is "
        "stated above as not available rather than inferred.",
        "",
        "Citations:",
    ]
    for i, c in enumerate(citations, start=1):
        locator = c.get("provision") or c.get("section")
        lines.append(f"[{i}] {c.get('document')} v{c.get('version') or '?'} §{locator}: {c.get('text')}")
    return "\n".join(lines)


def persist_memo_version(context):
    """Persist the draft as a new, immutable version — never an overwrite.

    Numbered per (case_id, cycle) starting at 1 for each cycle (see SLICES.md
    note (d)): a resubmission opens a fresh cycle and its memo numbering
    starts over, matching the acceptance's version 1 then version 2 for two
    consecutive drafts of the same cycle.
    """
    loaded = context.get("load_case") or {}
    case_id = loaded.get("case_id")
    row = case_by_id(case_id)
    if row is None:
        raise workflow_engine.WorkflowError("persist memo: case not found")
    cycle = loaded.get("cycle", row.get("cycle", 1))
    existing = [m for m in store.list(MEMO_TABLE) if m["case_id"] == case_id and m.get("cycle", 1) == cycle]
    version = len(existing) + 1
    agent_reply = (context.get("draft_memo") or {}).get("reply", "")
    citations = _build_citations(loaded)
    memo_text = _memo_text(loaded, citations, agent_reply, version)
    now = policy.iso(policy.now_utc())
    memo_row = store.insert(
        MEMO_TABLE,
        {
            "case_id": case_id,
            "cycle": cycle,
            "version": version,
            "memo_text": memo_text,
            "generated_at": now,
            "is_machine_drafted": True,
            "policy_citations": citations,
            "approved_at": None,
            "approved_by_user_id": None,
            "approved_by_role": None,
            "is_approved": False,
        },
    )
    entry = audit(
        case_id,
        "memo_drafted",
        "risk-memo-assistant",
        field_name="version",
        old_value=None,
        new_value=version,
        details={"memo_version_id": memo_row["id"], "is_machine_drafted": True, "cycle": cycle},
    )
    return {
        "case_id": case_id,
        "memo_version_id": memo_row["id"],
        "version": version,
        "memo_text": memo_text,
        "policy_citations": citations,
        "is_machine_drafted": True,
        "generated_at": now,
        "audit_entry_id": entry["id"],
    }


def validate_memo_citations(context):
    """Mechanically check every citation resolves and the label is present.

    Never trusts the agent's own claim: each citation is re-resolved through
    kyc_policy.resolve_citation() exactly as an auditor's GET
    /citations/resolve call would (REQ-032).
    """
    persisted = context.get("persist_memo") or {}
    citations = persisted.get("policy_citations") or []
    resolved, unresolved = [], []
    for c in citations:
        result = policy.resolve_citation(c.get("document"), c.get("section"))
        (resolved if result.get("resolved") else unresolved).append(c)
    text = (persisted.get("memo_text") or "").lower()
    label_present = "machine-drafted" in text and "requires human approval" in text
    return {
        "memo_version_id": persisted.get("memo_version_id"),
        "citations_resolved": not unresolved,
        "resolved_citations": resolved,
        "unresolved_citations": unresolved,
        "machine_drafted_label_present": label_present,
    }


for _name, _fn in [
    ("load_case_for_assessment", load_case_for_assessment),
    ("persist_memo_version", persist_memo_version),
    ("validate_memo_citations", validate_memo_citations),
]:
    workflow_engine.register_handler(_name, _fn)


# --------------------------------------------------------------------------
# Endpoints (registered outside /api/ — never shadowed by the catch-all)
# --------------------------------------------------------------------------
class MemoDraftRequest(BaseModel):
    case_reference: str
    requested_by: str = ""


@router.get("/policy-corpus")
def policy_corpus():
    """The versioned policy corpus the memo assistant is grounded in — nothing else (REQ-030)."""
    return {"documents": policy.POLICY_CORPUS, "versions": policy.policy_versions()}


@router.get("/citations/resolve")
def resolve_citation_endpoint(document: str = "", section: str = ""):
    """Resolve a cited provision back to its source document — REQ-032."""
    return policy.resolve_citation(document, section)


@router.post("/memos/draft")
def draft_memo(req: MemoDraftRequest, authorization: str | None = Header(default=None)):
    """Run the approved risk-memo-and-approval workflow through the draft.

    The workflow parks at its human approval_decision node right after this
    (slice 4's concern); what comes back here is exactly the persisted,
    machine-drafted, citation-checked version.
    """
    row = find_case(req.case_reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{req.case_reference}'")
    if row.get("total_risk_score") is None:
        raise HTTPException(
            status_code=400, detail="case has not passed completeness and scoring yet — nothing to assess"
        )
    requested_by = acting_user(authorization, req.requested_by) or "unknown"
    run_id = workflow_engine.start(
        "risk-memo-and-approval", {"case_reference": req.case_reference, "requested_by": requested_by}
    )
    state = workflow_engine.state(run_id)
    if state.get("status") == "failed":
        raise HTTPException(status_code=500, detail=f"memo drafting failed: {state.get('error')}")
    persisted = state["context"].get("persist_memo") or {}
    validated = state["context"].get("validate_citations") or {}
    if not persisted:
        raise HTTPException(status_code=500, detail="memo drafting did not persist a version")
    return {
        "case_reference": row["case_reference"],
        "case_id": persisted.get("case_id"),
        "memo_version_id": persisted.get("memo_version_id"),
        "version": persisted.get("version"),
        "memo_text": persisted.get("memo_text"),
        "policy_citations": persisted.get("policy_citations"),
        "is_machine_drafted": persisted.get("is_machine_drafted"),
        "generated_at": persisted.get("generated_at"),
        "citations_resolved": validated.get("citations_resolved"),
        "machine_drafted_label_present": validated.get("machine_drafted_label_present"),
        "requested_by": requested_by,
        "workflow_run_id": run_id,
        "workflow_status": state.get("status"),
    }


@router.get("/cases/{reference}/memos")
def list_case_memos(reference: str):
    """Every retained version of this case's memo — nothing is ever overwritten (REQ-039)."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    memos = [m for m in store.list(MEMO_TABLE) if m["case_id"] == row["id"]]
    memos.sort(key=lambda m: (m.get("cycle", 1), m["version"]))
    return {"case_reference": row["case_reference"], "memos": memos}
