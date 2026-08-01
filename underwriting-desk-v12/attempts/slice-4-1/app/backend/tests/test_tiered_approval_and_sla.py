"""Tests for slice `tiered-approval-and-sla`: tiered human approval,
adverse-action decline, return, and the SLA idle register."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import ext_tiered_approval_and_sla as slice_ext  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def setup_module(module):
    # test_deal_intake_and_triage.py's own deal submissions advance the
    # shared next_deal_code() sequence within this one pytest process and
    # can reuse (shadow) these same human-readable codes — force-refresh
    # our fixtures to known-good state right before this module's tests
    # run. A live app boot never needs this (see seed_fixture_deals's
    # docstring): only slice-1's acceptance check files one real deal.
    slice_ext.seed_fixture_deals(force=True)


def test_fixture_deals_are_seeded_and_visible_on_pipeline():
    codes = [d["deal_code"] for d in client.get("/api/deals").json()]
    assert "DEAL-1004" in codes
    assert "DEAL-1005" in codes
    assert "DEAL-1006" in codes


def test_analyst_cannot_approve_above_their_tier():
    resp = client.post(
        "/api/deals/DEAL-1004/approve",
        json={"acting_user_email": "analyst@bank.test", "decision_notes": "Looks fine to me"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_officer_can_approve_within_their_tier():
    resp = client.post(
        "/api/deals/DEAL-1004/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "Within policy, DSCR above floor"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "approved"
    assert body["approved_by_role"] == "senior_credit_officer"
    assert body["approved_by_email"] == "officer@bank.test"
    assert body["final_stage"] == "closing"

    approvals = client.get("/api/deals/DEAL-1004/approvals").json()
    assert any(a["decision"] == "approved" for a in approvals)


def test_double_approval_is_rejected():
    resp = client.post(
        "/api/deals/DEAL-1004/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "again"},
    )
    assert resp.status_code == 409


def test_decline_requires_controlled_reason_code():
    resp = client.post(
        "/api/deals/DEAL-1006/decline",
        json={"acting_user_email": "officer@bank.test", "reason_code": "MADE_UP_REASON", "reason_detail": "no"},
    )
    assert resp.status_code == 400


def test_analyst_cannot_decline():
    resp = client.post(
        "/api/deals/DEAL-1006/decline",
        json={"acting_user_email": "analyst@bank.test", "reason_code": "INSUFFICIENT_DSCR", "reason_detail": "DSCR too low"},
    )
    assert resp.status_code == 403


def test_officer_decline_with_adverse_action_reason():
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
    assert body["reason_code"] == "INSUFFICIENT_DSCR"
    assert body["current_stage"] == "declined"

    deal = next(d for d in client.get("/api/deals").json() if d["deal_code"] == "DEAL-1006")
    assert deal["decline_reason_code"] == "INSUFFICIENT_DSCR"


def test_sla_idle_register_lists_idle_deal_with_escalation_owner():
    # Asserted before anything below touches DEAL-1005, since a return or
    # reassignment resets its last_activity_timestamp (and thus its idle
    # clock) by design.
    resp = client.get("/api/sla/idle")
    assert resp.status_code == 200
    body = resp.json()
    ids = [d["deal_id"] for d in body["idle_deals"]]
    assert "DEAL-1005" in ids
    row = next(d for d in body["idle_deals"] if d["deal_id"] == "DEAL-1005")
    assert row["business_days_idle"] >= 5
    assert row["escalation_owner"]
    assert "stats" in body


def test_return_requires_a_written_reason():
    resp = client.post(
        "/api/deals/DEAL-1007/return",
        json={"acting_user_email": "officer@bank.test", "reason": ""},
    )
    assert resp.status_code == 400


def test_officer_can_return_a_deal():
    resp = client.post(
        "/api/deals/DEAL-1007/return",
        json={"acting_user_email": "officer@bank.test", "reason": "Spread needs the trailing tax return re-attached."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "returned"
    assert body["reassigned_to_user_id"] is not None


def test_return_resets_the_idle_clock():
    resp = client.get("/api/sla/idle")
    ids = [d["deal_id"] for d in resp.json()["idle_deals"]]
    assert "DEAL-1007" not in ids  # last_activity_timestamp was just reset


def test_sla_escalate_reassigns_a_deal():
    resp = client.post(
        "/api/deals/DEAL-1006/sla-escalate",
        json={"acting_user_email": "officer@bank.test", "action": "reassign", "note": "please pick this back up"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["action_taken"] == "reassign"
    assert body["reassigned_to_user_id"] is not None


def test_sla_escalate_requires_officer_role():
    resp = client.post(
        "/api/deals/DEAL-1006/sla-escalate",
        json={"acting_user_email": "rm@bank.test", "action": "acknowledge", "note": "noted"},
    )
    assert resp.status_code == 403


def test_unknown_deal_404s_on_approve():
    resp = client.post("/api/deals/DEAL-9999/approve", json={"acting_user_email": "officer@bank.test"})
    assert resp.status_code == 404
