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


# ---------------------------------------------------------------------------
# audit-finding regression tests (attempt 3)
# ---------------------------------------------------------------------------

def _fixture_deal(code, **overrides):
    """A pending-decision deal for a single test, inserted the same way
    seed_fixture_deals inserts DEAL-1004 (explicit deal_code, event-sourced)."""
    import identity as identity_module
    from db import store as _store

    officer = identity_module.resolve_user("officer@bank.test", default_role="senior_credit_officer")
    now = slice_ext._now()
    row = {
        "deal_code": code,
        "borrower_name": f"Fixture {code}",
        "borrower_industry": "manufacturing",
        "borrower_entity_id": None,
        "requested_amount": 200000,
        "exposure_amount": 200000,
        "current_stage": "tiered_approval",
        "current_status": "pending_decision",
        "created_by_user_id": officer["id"],
        "assigned_to_user_id": officer["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": now,
        "created_at": now,
        "updated_at": now,
    }
    row.update(overrides)
    return _store.insert("deals", row)


def test_seeded_fixture_deals_carry_no_policy_exception():
    """The recorded approval acceptance path must never trip the new gate."""
    for code in ("DEAL-1004", "DEAL-1005", "DEAL-1006", "DEAL-1007"):
        assert slice_ext.open_policy_exceptions(code) == []


def test_open_policy_exception_blocks_approval_until_waived():
    from db import store as _store

    _fixture_deal("DEAL-1091")
    _store.insert("policy_exceptions", {
        "deal_id": "DEAL-1091",
        "policy_rule_id": None,
        "rule_reference": "LP-DSCR-MIN",
        "violation_detail": "DSCR 0.90 below the 1.25 floor",
        "rationale": "raised by the policy compliance agent",
        "status": "open",
        "raised_by_user_id": None,
        "resolved_by_user_id": None,
        "resolved_at": None,
        "created_at": slice_ext._now(),
    })

    blocked = client.post(
        "/api/deals/DEAL-1091/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "ship it"},
    )
    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert "open policy exception" in detail
    assert "LP-DSCR-MIN" in detail
    assert "waive" in detail
    # nothing was recorded
    assert client.get("/api/deals/DEAL-1091/approvals").json() == []

    waived = client.post(
        "/api/deals/DEAL-1091/policy-exceptions/waive",
        json={
            "acting_user_email": "officer@bank.test",
            "rule_reference": "LP-DSCR-MIN",
            "rationale": "Guarantor pledged additional collateral; committee accepted the shortfall.",
        },
    )
    assert waived.status_code == 200
    assert waived.json()["status"] == "waived"
    assert waived.json()["open_exception_count"] == 0

    approved = client.post(
        "/api/deals/DEAL-1091/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "Approved over a waived exception"},
    )
    assert approved.status_code == 200
    assert approved.json()["decision"] == "approved"


def test_waiving_requires_officer_authority_and_a_rationale():
    from db import store as _store

    _fixture_deal("DEAL-1092")
    _store.insert("policy_exceptions", {
        "deal_id": "DEAL-1092",
        "rule_reference": "LP-INDUSTRY-EXCLUDED",
        "violation_detail": "Industry excluded under the active policy",
        "rationale": "raised by the policy compliance agent",
        "status": "open",
        "created_at": slice_ext._now(),
    })

    analyst = client.post(
        "/api/deals/DEAL-1092/policy-exceptions/waive",
        json={"acting_user_email": "analyst@bank.test", "rule_reference": "LP-INDUSTRY-EXCLUDED", "rationale": "fine"},
    )
    assert analyst.status_code == 403
    assert "authority" in analyst.json()["detail"]

    blank = client.post(
        "/api/deals/DEAL-1092/policy-exceptions/waive",
        json={"acting_user_email": "officer@bank.test", "rule_reference": "LP-INDUSTRY-EXCLUDED", "rationale": "   "},
    )
    assert blank.status_code == 400

    # still open, so the deal still cannot be approved
    assert len(slice_ext.open_policy_exceptions("DEAL-1092")) == 1
    assert client.post(
        "/api/deals/DEAL-1092/approve", json={"acting_user_email": "officer@bank.test"}
    ).status_code == 409


def test_return_uses_the_same_already_decided_guard():
    _fixture_deal("DEAL-1093")
    approved = client.post(
        "/api/deals/DEAL-1093/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "within tier"},
    )
    assert approved.status_code == 200

    resp = client.post(
        "/api/deals/DEAL-1093/return",
        json={"acting_user_email": "officer@bank.test", "reason": "Actually, send it back."},
    )
    assert resp.status_code == 409
    assert "already has a recorded decision" in resp.json()["detail"]


def test_unknown_user_is_denied_every_decision_path():
    """Default-deny through identity.require_actor: an email that resolves to
    no stored user may not approve, decline, return, waive or escalate — and
    is never provisioned as a side effect of trying."""
    import identity as identity_module

    ghost = "ghost@evil.test"
    _fixture_deal("DEAL-1094")

    calls = [
        ("/api/deals/DEAL-1094/approve", {"acting_user_email": ghost}),
        ("/api/deals/DEAL-1094/decline", {"acting_user_email": ghost, "reason_code": "OTHER", "reason_detail": "x"}),
        ("/api/deals/DEAL-1094/return", {"acting_user_email": ghost, "reason": "x"}),
        ("/api/deals/DEAL-1094/policy-exceptions/waive",
         {"acting_user_email": ghost, "rule_reference": "LP-DSCR-MIN", "rationale": "x"}),
        ("/api/deals/DEAL-1094/sla-escalate", {"acting_user_email": ghost, "action": "acknowledge"}),
    ]
    for path, payload in calls:
        resp = client.post(path, json=payload)
        assert resp.status_code == 403, path
        assert "authority" in resp.json()["detail"], path

    assert identity_module.find_user(ghost) is None
    assert client.get("/api/deals/DEAL-1094/approvals").json() == []


def test_approval_tier_is_read_from_the_stored_role_not_the_request():
    """A caller cannot talk itself up a tier: the role comes off the users row."""
    import identity as identity_module

    _fixture_deal("DEAL-1095", requested_amount=900000, exposure_amount=900000)
    resp = client.post(
        "/api/deals/DEAL-1095/approve",
        json={"acting_user_email": "analyst@bank.test", "role": "senior_credit_officer", "decision_notes": "trust me"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]
    assert identity_module.find_user("analyst@bank.test")["role"] == "credit_analyst"

    # $900k is inside the senior officer tier, above the analyst's $250k.
    ok = client.post(
        "/api/deals/DEAL-1095/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "within the officer tier"},
    )
    assert ok.status_code == 200
    assert ok.json()["required_authority_level"] == "senior_credit_officer_tier"


def test_committee_tier_is_above_the_senior_officer():
    _fixture_deal("DEAL-1096", requested_amount=2500000, exposure_amount=2500000)
    resp = client.post(
        "/api/deals/DEAL-1096/approve",
        json={"acting_user_email": "officer@bank.test", "decision_notes": "big one"},
    )
    assert resp.status_code == 403
    assert "credit_committee" in resp.json()["detail"]
