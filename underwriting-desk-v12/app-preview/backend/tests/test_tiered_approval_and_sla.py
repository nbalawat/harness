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
    resp = client.get("/api/sla/idle?acting_user_email=officer@bank.test")
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
    rows = [
        r for r in client.get(
            f"/api/deals/{code}/decisions?acting_user_email=officer@bank.test"
        ).json()["approvals"]
    ]
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
    tiers = client.get("/api/approval-tiers?acting_user_email=officer@bank.test").json()
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
    record = client.get(f"/api/deals/{code}/decisions?acting_user_email=officer@bank.test").json()
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
    before = client.get("/api/sla/idle?acting_user_email=officer@bank.test").json()
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
    after = client.get("/api/sla/idle?acting_user_email=officer@bank.test").json()
    assert not any(d["deal_code"] == "DEAL-1042" for d in after["deals"])


def test_analyst_cannot_reassign_from_the_register():
    resp = client.post(
        "/api/deals/DEAL-1005/reassign",
        json={"acting_user_email": "analyst@bank.test", "assign_to_email": "analyst@bank.test"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_escalation_parks_for_a_human_and_only_applies_after_a_separate_decision():
    """measure -> breached -> blockers -> human park -> (SECOND ACT) -> apply.

    Opening the escalation must NOT apply it: a request that signs off its own
    park point is not a human gate. The deal must be untouched until the
    officer confirms in a separate call.
    """
    opened = client.post(
        "/api/sla/DEAL-1041/escalate",
        json={
            "acting_user_email": "officer@bank.test",
            "action": "return",
            "returned_to_stage": "document_extraction",
            "note": "Sitting on missing statements — send it back for documents",
        },
    )
    assert opened.status_code == 200
    body = opened.json()
    assert body["sla_breached"] is True
    assert body["blocking_items"]
    assert body["status"] == "parked"
    assert body["awaiting_human_decision"] is True
    assert body["action_taken"] == "none"
    # Nothing has happened to the deal yet.
    assert deals_repo.get_deal("DEAL-1041")["current_stage"] == "policy_compliance"

    decided = client.post(
        f"/api/sla/runs/{body['run_id']}/decide",
        json={"acting_user_email": "officer@bank.test", "confirm": True, "reason": "send it back"},
    )
    assert decided.status_code == 200
    applied = decided.json()
    assert applied["status"] == "completed"
    assert applied["action_taken"] == "return"
    assert applied["returned_to_stage"] == "document_extraction"
    state = client.get(f"/workflows/runs/{body['run_id']}").json()
    assert state["status"] == "completed"
    assert state["context"]["apply"]["decided_by_user_id"]
    assert deals_repo.get_deal("DEAL-1041")["current_stage"] == "document_extraction"


def test_a_refused_escalation_leaves_the_deal_untouched():
    opened = client.post(
        "/api/sla/DEAL-1005/escalate",
        json={
            "acting_user_email": "officer@bank.test",
            "action": "return",
            "returned_to_stage": "intake",
            "note": "proposed",
        },
    ).json()
    assert opened["awaiting_human_decision"] is True
    before = deals_repo.get_deal("DEAL-1005")["current_stage"]
    refused = client.post(
        f"/api/sla/runs/{opened['run_id']}/decide",
        json={"acting_user_email": "officer@bank.test", "confirm": False, "reason": "leave it with the owner"},
    )
    assert refused.status_code == 200
    assert refused.json()["action_taken"] == "none"
    assert deals_repo.get_deal("DEAL-1005")["current_stage"] == before
    # ...and the run cannot be decided twice.
    assert client.post(
        f"/api/sla/runs/{opened['run_id']}/decide",
        json={"acting_user_email": "officer@bank.test", "confirm": True},
    ).status_code == 409


def test_only_an_officer_can_decide_a_parked_escalation():
    opened = client.post(
        "/api/sla/DEAL-1042/escalate",
        json={"acting_user_email": "officer@bank.test", "action": "acknowledge", "note": "watching"},
    ).json()
    if opened.get("awaiting_human_decision"):
        assert client.post(
            f"/api/sla/runs/{opened['run_id']}/decide",
            json={"acting_user_email": "analyst@bank.test", "confirm": True},
        ).status_code == 403
        assert client.post(
            f"/api/sla/runs/{opened['run_id']}/decide",
            json={"acting_user_email": "", "confirm": True},
        ).status_code == 401
    assert client.post(
        "/api/sla/runs/wf-does-not-exist/decide",
        json={"acting_user_email": "officer@bank.test", "confirm": True},
    ).status_code == 404


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

    record_node = next(n for n in lifecycle["nodes"] if n["id"] == "record")
    recorded = approvals.record_approval_decision({"inputs": {
        "deal_id": code,
        "acting_user_email": "officer@bank.test",
        "decision": "approved",
        "decision_notes": "inside policy",
    }})
    for field in record_node["output_schema"]["required"]:
        assert field in recorded, field

    outcome_node = next(n for n in lifecycle["nodes"] if n["id"] == "outcome")
    outcome = approvals.record_adverse_action_or_return({"inputs": {
        "deal_id": code,
        "acting_user_email": "officer@bank.test",
        "outcome": "approved",
    }})
    for field in outcome_node["output_schema"]["required"]:
        assert field in outcome, field

    close_node = next(n for n in lifecycle["nodes"] if n["id"] == "close")
    closed = approvals.close_approved_deal({"inputs": {"deal_id": code, "acting_user_email": "officer@bank.test"}})
    for field in close_node["output_schema"]["required"]:
        assert field in closed, field


def test_workflow_definitions_still_validate():
    import workflow_engine

    assert workflow_engine.validate_definitions() == []


# ---------------------------------------------------------------------------
# Security remediation — the governance findings closed on this slice.
# These are the NEGATIVE acceptance checks: what the desk must REFUSE.
# ---------------------------------------------------------------------------

def test_a_credit_decision_is_never_defaulted_to_approved():
    """An omitted decision is a 422 — silence is not consent."""
    code = _fresh_deal(60000)
    omitted = client.post(
        f"/api/deals/{code}/decision",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "…"},
    )
    assert omitted.status_code == 422
    assert "explicit" in omitted.json()["detail"]

    blank = client.post(
        f"/api/deals/{code}/decision",
        json={"acting_user_email": "officer@bank.test", "decision": "   "},
    )
    assert blank.status_code == 422

    bogus = client.post(
        f"/api/deals/{code}/decision",
        json={"acting_user_email": "officer@bank.test", "decision": "maybe"},
    )
    assert bogus.status_code == 422

    # ...and nothing was recorded by any of those attempts.
    record = client.get(f"/api/deals/{code}/decisions?acting_user_email=officer@bank.test").json()
    assert record["approvals"] == []

    stated = client.post(
        f"/api/deals/{code}/decision",
        json={"acting_user_email": "officer@bank.test", "decision": "approved", "decision_notes": "ok"},
    )
    assert stated.status_code == 200
    assert stated.json()["decision"] == "approved"


def test_the_workflow_handler_itself_refuses_an_omitted_decision():
    import pytest
    from fastapi import HTTPException

    code = _fresh_deal(60000)
    with pytest.raises(HTTPException) as raised:
        approvals.record_approval_decision({"inputs": {
            "deal_id": code,
            "acting_user_email": "officer@bank.test",
        }})
    assert raised.value.status_code == 422


def test_approval_requires_the_deal_to_have_reached_the_approval_gate():
    code = _fresh_deal(60000, stage="financial_spreading")
    resp = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "rushing it"},
    )
    assert resp.status_code == 409
    assert "tiered_approval" in resp.json()["detail"]


def test_approval_is_blocked_by_an_open_policy_exception():
    from db import store

    code = _fresh_deal(60000)
    store.insert("policy_exceptions", {
        "deal_id": code,
        "rule_reference": "LP-DSCR-01",
        "rationale": "DSCR below the floor",
        "status": "open",
    })
    blocked = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "waving it through"},
    )
    assert blocked.status_code == 409
    assert "LP-DSCR-01" in blocked.json()["detail"]

    # Once a human waives it, the same approval goes through.
    store.insert("policy_exceptions", {
        "deal_id": code,
        "rule_reference": "LP-DSCR-01",
        "rationale": "DSCR below the floor",
        "status": "open",
    })
    for row in store.list("policy_exceptions"):
        if row.get("deal_id") == code:
            row["status"] = "waived"
    assert client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "exception waived"},
    ).status_code == 200


def test_a_settled_deal_cannot_be_returned():
    code = _fresh_deal(90000)
    client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "officer@bank.test"})
    resp = client.post(
        f"/api/deals/{code}/return",
        json={
            "acting_user_email": "officer@bank.test",
            "returned_to_stage": "financial_spreading",
            "reason": "second thoughts",
        },
    )
    assert resp.status_code == 409
    assert "settled" in resp.json()["detail"]


def test_scoped_reads_are_fail_closed_for_an_anonymous_or_forged_caller():
    """401 with no identity, 403 with one that resolves to nobody."""
    assert client.get("/api/approval-tiers").status_code == 401
    assert client.get("/api/deals/DEAL-1004/decisions").status_code == 401
    assert client.get("/api/approval-tiers?acting_user_email=%20").status_code == 401

    assert client.get("/api/approval-tiers?acting_user_email=ghost@evil.test").status_code == 403
    assert client.get("/api/deals/DEAL-1004/decisions?acting_user_email=ghost@evil.test").status_code == 403

    # The desk UI's header identity is accepted by the same guard.
    assert client.get(
        "/api/approval-tiers", headers={"X-User-Email": "officer@bank.test"}
    ).status_code == 200
    assert client.get(
        "/api/deals/DEAL-1004/decisions", headers={"X-User-Email": "ghost@evil.test"}
    ).status_code == 403


def test_the_idle_register_is_scoped_and_redacted_rather_than_opt_out():
    """No `if acting_user_email:` opt-out: a forged reader is refused, and an
    unidentified one gets the service line WITHOUT exposures or owning desks."""
    assert client.get("/api/sla/idle?acting_user_email=ghost@evil.test").status_code == 403

    anonymous = client.get("/api/sla/idle").json()
    assert anonymous["deals"], "the service line itself is the desk's shared wall"
    for row in anonymous["deals"]:
        assert row["redacted"] is True
        assert "exposure_amount" not in row
        assert "owner_email" not in row
        assert "blocking_items" not in row
    assert anonymous["idle_exposure"] == 0
    assert anonymous["by_owner"] == {}

    identified = client.get("/api/sla/idle?acting_user_email=officer@bank.test").json()
    assert identified["deals"][0]["owner_email"] is not None or identified["deals"][0]["owner"]
    assert identified["idle_exposure"] > 0

    # An RM sees only its own book, never the whole register.
    rm = client.get("/api/sla/idle?acting_user_email=rm@bank.test").json()
    assert len(rm["deals"]) <= len(identified["deals"])


def test_an_adverse_action_needs_an_actor_and_a_controlled_stored_reason():
    import pytest
    from fastapi import HTTPException

    code = _fresh_deal(75000)

    with pytest.raises(HTTPException) as anonymous:
        approvals.record_adverse_action_or_return({"inputs": {
            "deal_id": code,
            "outcome": "declined",
            "adverse_action_reason_code": "INSUFFICIENT_DSCR",
            "adverse_action_detail": "below the floor",
        }})
    assert anonymous.value.status_code == 401

    with pytest.raises(HTTPException) as defaulted:
        approvals.record_adverse_action_or_return({"inputs": {
            "deal_id": code,
            "acting_user_email": "officer@bank.test",
        }})
    assert defaulted.value.status_code == 422

    with pytest.raises(HTTPException) as freetext:
        approvals.record_adverse_action_or_return({"inputs": {
            "deal_id": code,
            "acting_user_email": "officer@bank.test",
            "outcome": "declined",
            "adverse_action_reason_code": "BECAUSE_I_SAID_SO",
            "adverse_action_detail": "vibes",
        }})
    assert freetext.value.status_code == 422

    with pytest.raises(HTTPException) as unpermitted:
        approvals.record_adverse_action_or_return({"inputs": {
            "deal_id": code,
            "acting_user_email": "analyst@bank.test",
            "outcome": "declined",
            "adverse_action_reason_code": "INSUFFICIENT_DSCR",
            "adverse_action_detail": "below the floor",
        }})
    assert unpermitted.value.status_code == 403

    out = approvals.record_adverse_action_or_return({"inputs": {
        "deal_id": code,
        "acting_user_email": "officer@bank.test",
        "outcome": "declined",
        "adverse_action_reason_code": "EXCESSIVE_LEVERAGE",
        "adverse_action_detail": "Leverage of 6.1x is above the 4.0x ceiling",
    }})
    assert out["adverse_action_reason_code"] == "EXCESSIVE_LEVERAGE"
    # The reason is STORED, not merely echoed.
    stored = deals_repo.get_deal(code)
    assert stored["decline_reason_code"] == "EXCESSIVE_LEVERAGE"
    assert "6.1x" in stored["decline_reason_detail"]


def test_closing_a_deal_needs_authority_and_a_recorded_approval():
    import pytest
    from fastapi import HTTPException

    code = _fresh_deal(65000)
    with pytest.raises(HTTPException) as unapproved:
        approvals.close_approved_deal({"inputs": {"deal_id": code, "acting_user_email": "officer@bank.test"}})
    assert unapproved.value.status_code == 409

    with pytest.raises(HTTPException) as anonymous:
        approvals.close_approved_deal({"inputs": {"deal_id": code}})
    assert anonymous.value.status_code == 401
