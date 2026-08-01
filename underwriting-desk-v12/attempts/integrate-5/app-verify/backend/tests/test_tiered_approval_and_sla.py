"""Tests for slice `tiered-approval-and-sla`: tiered human approval, adverse
action, deal returns, and the business-day idle register."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import deals_repo  # noqa: E402
import ext_tiered_approval_and_sla as approvals  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def _fresh_deal(amount, stage="tiered_approval"):
    """A deal filed through the real intake endpoint, moved to a stage."""
    created = client.post(
        "/api/deals",
        json={
            "borrower_name": f"Tier Test {amount}",
            "borrower_industry": "retail",
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": "rm@bank.test",
        },
    ).json()
    deals_repo.update_deal(created["deal_code"], current_stage=stage, current_status="awaiting_approval")
    return created["deal_code"]


# ---------------------------------------------------------------------------
# Acceptance paths
# ---------------------------------------------------------------------------

def test_analyst_cannot_approve_above_the_exposure_ceiling():
    resp = client.post(
        "/api/deals/DEAL-1004/approve",
        json={"acting_user_email": "analyst@bank.test", "decision_notes": "Looks fine to me"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]
    assert "senior_credit_officer" in resp.json()["detail"]
    # ...and nothing was written: the deal is still awaiting a decision.
    assert deals_repo.get_deal("DEAL-1004")["current_status"] == "awaiting_approval"


def test_officer_approves_above_the_ceiling():
    resp = client.post(
        "/api/deals/DEAL-1004/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "Within policy, DSCR above floor"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "approved"
    assert body["is_approved"] is True
    assert body["approval_authority_level"] == "senior_credit_officer"
    assert body["decided_by"] == "officer@bank.test"
    assert body["authority_level_verified"] is True
    assert body["current_stage"] == "closing"
    assert body["current_status"] == "approved"


def test_officer_declines_with_a_controlled_adverse_action_reason():
    resp = client.post(
        "/api/deals/DEAL-1006/decline",
        json={
            "acting_user_email": "officer@bank.test",
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "DSCR of 0.82 is below the 1.25 policy floor",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "declined"
    assert body["adverse_action_reason_code"] == "INSUFFICIENT_DSCR"
    assert body["current_status"] == "declined"
    stored = deals_repo.get_deal("DEAL-1006")
    assert stored["decline_reason_code"] == "INSUFFICIENT_DSCR"
    assert "1.25" in stored["decline_reason_detail"]


def test_idle_register_lists_deals_past_the_service_line():
    resp = client.get("/api/sla/idle")
    assert resp.status_code == 200
    body = resp.json()
    codes = [d["deal_code"] for d in body["deals"]]
    assert "DEAL-1005" in codes
    row = next(d for d in body["deals"] if d["deal_code"] == "DEAL-1005")
    assert row["business_days_idle"] > 5
    assert row["sla_breached"] is True
    assert row["escalation_owner"] == "officer@bank.test"
    assert row["blocking_items"], "an idle deal must say what is blocking it"
    # worst-first ordering
    idle = [d["business_days_idle"] for d in body["deals"]]
    assert idle == sorted(idle, reverse=True)


# ---------------------------------------------------------------------------
# Authority ladder
# ---------------------------------------------------------------------------

def test_analyst_holds_authority_below_the_ceiling():
    code = _fresh_deal(120000)
    resp = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "analyst@bank.test", "decision_notes": "Small ticket, inside my authority"},
    )
    assert resp.status_code == 200
    assert resp.json()["approval_authority_level"] == "credit_analyst"


def test_exposure_exactly_at_the_ceiling_stays_with_the_analyst_tier():
    assert approvals.tier_for(250000)["level"] == "credit_analyst"
    assert approvals.tier_for(250000.01)["level"] == "senior_credit_officer"


def test_relationship_manager_cannot_approve_anything():
    code = _fresh_deal(10000)
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "rm@bank.test"})
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_unknown_caller_cannot_approve():
    code = _fresh_deal(10000)
    assert client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "nobody@evil.test"}).status_code == 403


def test_approval_is_idempotent():
    code = _fresh_deal(80000)
    first = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "go"},
    ).json()
    second = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "go"},
    ).json()
    assert first["approval_id"] == second["approval_id"]
    assert second["replayed"] is True
    rows = [r for r in client.get(f"/api/deals/{code}/decisions").json()["approvals"]]
    assert len(rows) == 1


def test_an_approved_deal_cannot_then_be_declined():
    code = _fresh_deal(80000)
    client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "officer@bank.test"})
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={
            "acting_user_email": "officer@bank.test",
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "changed my mind",
        },
    )
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Adverse action
# ---------------------------------------------------------------------------

def test_decline_requires_a_controlled_reason_code():
    code = _fresh_deal(90000)
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={"acting_user_email": "officer@bank.test", "reason_code": "I_DONT_LIKE_IT", "reason_detail": "vibes"},
    )
    assert resp.status_code == 400
    assert "INSUFFICIENT_DSCR" in resp.json()["detail"]


def test_decline_requires_written_detail():
    code = _fresh_deal(90000)
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={"acting_user_email": "officer@bank.test", "reason_code": "INSUFFICIENT_DSCR", "reason_detail": "  "},
    )
    assert resp.status_code == 400


def test_analyst_cannot_issue_an_adverse_action():
    code = _fresh_deal(50000)
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={
            "acting_user_email": "analyst@bank.test",
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "below floor",
        },
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_reason_codes_are_published_as_reference_data():
    codes = [r["reason_code"] for r in client.get("/api/adverse_action_reasons").json()]
    assert "INSUFFICIENT_DSCR" in codes
    tiers = client.get("/api/approval-tiers").json()
    assert tiers["ceiling"] == 250000
    assert [t["level"] for t in tiers["tiers"]] == ["credit_analyst", "senior_credit_officer"]


# ---------------------------------------------------------------------------
# Returns
# ---------------------------------------------------------------------------

def test_officer_returns_a_deal_to_an_earlier_stage():
    code = _fresh_deal(300000)
    resp = client.post(
        f"/api/deals/{code}/return",
        json={
            "acting_user_email": "officer@bank.test",
            "returned_to_stage": "financial_spreading",
            "reason": "Spread omits the Q4 interest expense line",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["current_stage"] == "financial_spreading"
    assert resp.json()["current_status"] == "returned"
    record = client.get(f"/api/deals/{code}/decisions").json()
    assert record["returns"][0]["reason"].startswith("Spread omits")


def test_return_rejects_an_unknown_stage_and_an_empty_reason():
    code = _fresh_deal(300000)
    assert client.post(
        f"/api/deals/{code}/return",
        json={"acting_user_email": "officer@bank.test", "returned_to_stage": "nowhere", "reason": "x"},
    ).status_code == 400
    assert client.post(
        f"/api/deals/{code}/return",
        json={"acting_user_email": "officer@bank.test", "returned_to_stage": "intake", "reason": ""},
    ).status_code == 400


# ---------------------------------------------------------------------------
# The service line: deterministic business-day arithmetic
# ---------------------------------------------------------------------------

def test_business_day_math_excludes_weekends_and_holidays():
    # Fri 2026-07-17 -> Mon 2026-07-20 is one business day (the weekend is skipped)
    assert approvals.business_days_between("2026-07-17T09:00:00+00:00",
                                           __import__("datetime").datetime.fromisoformat("2026-07-20T09:00:00+00:00")) == 1
    # Thu 2026-07-02 -> Mon 2026-07-06 spans the observed Independence Day holiday
    assert approvals.business_days_between("2026-07-02T09:00:00+00:00",
                                           __import__("datetime").datetime.fromisoformat("2026-07-06T09:00:00+00:00")) == 1


def test_reassigning_an_idle_deal_resets_its_clock_and_moves_the_desk():
    before = client.get("/api/sla/idle").json()
    assert any(d["deal_code"] == "DEAL-1042" for d in before["deals"])
    resp = client.post(
        "/api/deals/DEAL-1042/reassign",
        json={
            "acting_user_email": "officer@bank.test",
            "assign_to_email": "analyst@bank.test",
            "note": "Picked up from the register",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["assigned_to"] == "analyst@bank.test"
    after = client.get("/api/sla/idle").json()
    assert not any(d["deal_code"] == "DEAL-1042" for d in after["deals"])


def test_analyst_cannot_reassign_from_the_register():
    resp = client.post(
        "/api/deals/DEAL-1005/reassign",
        json={"acting_user_email": "analyst@bank.test", "assign_to_email": "analyst@bank.test"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_escalation_runs_the_sla_workflow_end_to_end():
    """measure -> breached -> blockers -> human park -> apply, through the engine."""
    resp = client.post(
        "/api/sla/DEAL-1041/escalate",
        json={
            "acting_user_email": "officer@bank.test",
            "action": "return",
            "returned_to_stage": "document_extraction",
            "note": "Sitting on missing statements — send it back for documents",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sla_breached"] is True
    assert body["action_taken"] == "return"
    assert body["returned_to_stage"] == "document_extraction"
    assert body["blocking_items"]
    assert body["status"] == "completed"
    state = client.get(f"/workflows/runs/{body['run_id']}").json()
    assert state["status"] == "completed"
    assert state["context"]["apply"]["decided_by_user_id"]
    assert deals_repo.get_deal("DEAL-1041")["current_stage"] == "document_extraction"


def test_escalation_requires_officer_authority():
    resp = client.post(
        "/api/sla/DEAL-1005/escalate",
        json={"acting_user_email": "analyst@bank.test", "action": "acknowledge", "note": "mine"},
    )
    assert resp.status_code == 403


def test_unknown_deal_is_404_on_every_decision_route():
    assert client.post("/api/deals/DEAL-9999/approve", json={"acting_user_email": "officer@bank.test"}).status_code == 404
    assert client.post(
        "/api/deals/DEAL-9999/decline",
        json={"acting_user_email": "officer@bank.test", "reason_code": "INSUFFICIENT_DSCR", "reason_detail": "x"},
    ).status_code == 404


# ---------------------------------------------------------------------------
# Audit + workflow contracts
# ---------------------------------------------------------------------------

def test_every_decision_writes_an_attributable_audit_row():
    code = _fresh_deal(70000)
    client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "officer@bank.test", "decision_notes": "ok"})
    entries = client.get("/audit").json()
    approved = [e for e in entries if e["event"] == "deal.approved" and e["detail"].get("deal_id") == code]
    assert approved, "an approval must leave an audit entry"
    assert approved[0]["actor"] == "officer@bank.test"
    assert approved[0]["detail"]["actor_user_id"]


def test_registered_workflow_handlers_satisfy_their_output_contracts():
    import workflow_engine

    for name in (
        "determine_approval_tier",
        "record_approval_decision",
        "record_adverse_action_or_return",
        "close_approved_deal",
        "compute_business_day_idle_time",
        "collect_stage_blockers",
        "apply_sla_escalation_action",
    ):
        assert name in workflow_engine._handlers, name

    lifecycle = next(w for w in workflow_engine.definitions() if w["name"] == "deal-underwriting-lifecycle")
    code = _fresh_deal(400000)
    tier_node = next(n for n in lifecycle["nodes"] if n["id"] == "tier")
    out = approvals.determine_approval_tier({"inputs": {"deal_id": code, "acting_user_email": "officer@bank.test"}})
    for field in tier_node["output_schema"]["required"]:
        assert field in out, field
    assert out["required_authority_level"] == "senior_credit_officer"

    close_node = next(n for n in lifecycle["nodes"] if n["id"] == "close")
    closed = approvals.close_approved_deal({"inputs": {"deal_id": code, "acting_user_email": "officer@bank.test"}})
    for field in close_node["output_schema"]["required"]:
        assert field in closed, field


def test_workflow_definitions_still_validate():
    import workflow_engine

    assert workflow_engine.validate_definitions() == []
