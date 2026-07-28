"""Slice 2 — deterministic risk scoring and banding.

The score is a pure, mechanical function of recorded factor inputs plus the
Risk Rating Matrix version (kyc_policy.score_factors): five weighted factors,
a Low/Medium/High band, and a sanctions true-positive override that forces
High regardless of the weighted total. No AI is involved (REQ-016) and no
role — not even a Compliance Officer — may edit the computed score or band
(REQ-027): `POST /cases/{reference}/score` always refuses with 403.

The score itself is computed and persisted by slice 1's workflow handler
`compute_risk_score_from_matrix` in ext_cases.py (registered against
workflows.json's case-intake-and-risk-scoring run) — this module adds the
standalone read/verify surface: the published matrix, an ad-hoc calculator
against raw factors, the per-case score-breakdown view (REQ-091), and the
refusal of any edit attempt.

Composition contract:
  * storage -> db.store only (reads the `risk_scores` table; writes nothing
               new — the workflow handler already owns that table)
  * routes  -> mounted outside /api/ so the /api/{table} catch-all in main.py
               can never shadow them
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import kyc_policy as policy
from db import store
from ext_cases import acting_user, audit, find_case

router = APIRouter()


class ScoreRequest(BaseModel):
    factors: dict = Field(default_factory=dict)


class ScoreEditAttempt(BaseModel):
    total_risk_score: float | None = None
    risk_band: str | None = None
    acting_user: str = ""


@router.get("/risk-matrix")
def get_risk_matrix():
    """The versioned Risk Rating Matrix every case's score is computed against."""
    return policy.risk_matrix_definition()


@router.post("/risk/score")
def compute_score(req: ScoreRequest):
    """Run the deterministic engine against raw factors — no case required.

    Pure function of its inputs (REQ-028): the same factors and matrix
    version always yield the same total and band, so calling this twice with
    the same body always returns the same result.
    """
    return policy.score_factors(req.factors)


def _latest_risk_score_row(case_id, cycle):
    matches = [r for r in store.list("risk_scores") if r["case_id"] == case_id and r.get("cycle", 1) == cycle]
    return matches[-1] if matches else None


@router.get("/cases/{reference}/score-breakdown")
def score_breakdown(reference: str):
    """Each factor's input, raw score, weight and contribution (REQ-091)."""
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    cycle = row.get("cycle", 1)
    score_row = _latest_risk_score_row(row["id"], cycle)
    if score_row is None:
        raise HTTPException(status_code=404, detail=f"case '{reference}' has not been scored yet")
    return {
        "case_reference": row["case_reference"],
        "cycle": cycle,
        "total_risk_score": score_row["total_risk_score"],
        "risk_band": score_row["risk_band"],
        "required_approver_role": policy.required_approver_role(score_row["risk_band"]),
        "sanctions_true_positive_override_applied": score_row.get("sanctions_true_positive_override_applied"),
        "risk_matrix_version": score_row.get("risk_matrix_version"),
        "computed_at": score_row.get("computed_at"),
        "factor_weights": score_row.get("factor_weights"),
        "factor_contributions": score_row.get("factor_contributions"),
        "factor_breakdown": score_row.get("factor_breakdown"),
    }


@router.post("/cases/{reference}/score")
def attempt_score_edit(reference: str, req: ScoreEditAttempt, authorization: str | None = Header(default=None)):
    """Never permitted — the computed score/band cannot be edited by any role.

    Scoring is mechanical (REQ-027): the score field is never directly
    editable, by a compliance officer or anyone else. The attempt itself is
    written to the case's audit trail so a coerced or careless try still
    leaves a record.
    """
    row = find_case(reference)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no case with reference '{reference}'")
    who = acting_user(authorization, req.acting_user) or "unknown"
    audit(
        row["id"],
        "score_edit_refused",
        who,
        field_name="total_risk_score",
        old_value=row.get("total_risk_score"),
        new_value=req.total_risk_score,
        details={
            "attempted_risk_band": req.risk_band,
            "reason": "the risk score is computed mechanically from the risk rating matrix and is not editable by any role",
        },
    )
    raise HTTPException(
        status_code=403,
        detail=(
            "The risk score and band are computed mechanically from the risk rating matrix "
            "and cannot be edited by any role, including a compliance_officer."
        ),
    )
