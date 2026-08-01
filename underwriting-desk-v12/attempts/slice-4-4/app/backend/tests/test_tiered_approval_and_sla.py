"""Tests for slice `tiered-approval-and-sla`: exposure-tiered approval
authority, adverse-action declines, officer returns, and the business-day
SLA idle register.

Money and authority are deterministic by requirement (R-020..R-023), so these
tests assert exact tiers, exact idle counts, and exact refusals — nothing here
depends on a model reply.
"""
import datetime
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import deals_repo  # noqa: E402
import ext_tiered_approval_and_sla as approvals  # noqa: E402
from db import store  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

OFFICER = "officer@bank.test"
ANALYST = "analyst@bank.test"
RM = "rm@bank.test"


def _fixture_deal(**fields):
    """A deal parked wherever the test needs it, without going through intake."""
    import identity

    rm = identity.resolve_user(RM)
    analyst = identity.resolve_user(ANALYST, default_role="credit_analyst")
    code = f"DEAL-T{len(store.list('deals')) + 900}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    row = {
        "deal_code": code,
        "borrower_name": "Test Borrower",
        "borrower_industry": "retail",
        "borrower_entity_id": None,
        "requested_amount": 100000,
        "exposure_amount": 100000,
        "current_stage": "tiered_approval",
        "current_status": "awaiting_decision",
        "created_by_user_id": rm["id"],
        "assigned_to_user_id": analyst["id"],
        "risk_grade": None,
        "decline_reason_code": None,
        "decline_reason_detail": None,
        "last_activity_timestamp": now,
        "created_at": now,
        "updated_at": now,
    }
    row.update(fields)
    store.insert("deals", row)
    return code


# ---------------------------------------------------------------------------
# Tiering is pure arithmetic (R-020/R-021/R-022)
# ---------------------------------------------------------------------------

def test_tier_boundaries_are_exact():
    assert approvals.tier_for(1)[0] == "credit_analyst"
    assert approvals.tier_for(250000)[0] == "credit_analyst"
    assert approvals.tier_for(250000.01)[0] == "senior_credit_officer"
    assert approvals.tier_for(1000000)[0] == "senior_credit_officer"
    assert approvals.tier_for(1000000.01)[0] == "credit_committee"


def test_analyst_may_approve_inside_its_ceiling():
    code = _fixture_deal(exposure_amount=250000, requested_amount=250000)
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": ANALYST})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["required_authority_level"] == "credit_analyst"
    assert body["decided_by_email"] == ANALYST


def test_analyst_may_not_approve_above_its_ceiling():
    code = _fixture_deal(exposure_amount=250001, requested_amount=250001)
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": ANALYST})
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]
    # nothing was written
    assert not [a for a in store.list("approvals") if a.get("deal_id") == code]
    assert deals_repo.get_deal(code)["current_stage"] == "tiered_approval"


def test_officer_may_not_approve_above_one_million():
    code = _fixture_deal(exposure_amount=1000001, requested_amount=1000001)
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": OFFICER})
    assert resp.status_code == 403
    assert "credit_committee" in resp.json()["detail"]


def test_relationship_manager_never_approves():
    code = _fixture_deal(exposure_amount=1000, requested_amount=1000)
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": RM})
    assert resp.status_code == 403


def test_unknown_and_anonymous_callers_are_denied():
    code = _fixture_deal()
    assert client.post(f"/api/deals/{code}/approve", json={"acting_user_email": "nobody@evil.test"}).status_code == 403
    assert client.post(f"/api/deals/{code}/approve", json={"acting_user_email": ""}).status_code == 401


# ---------------------------------------------------------------------------
# A named human decision, recorded once (R-024/R-030/R-062)
# ---------------------------------------------------------------------------

def test_officer_approval_records_identity_audit_and_closing_stage():
    code = _fixture_deal(exposure_amount=750000, requested_amount=750000)
    resp = client.post(
        f"/api/deals/{code}/approve",
        json={"acting_user_email": OFFICER, "decision_notes": "Within policy, DSCR above floor"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["required_authority_level"] == "senior_credit_officer"
    assert body["approved_by_email"] == OFFICER
    assert body["final_stage"] == "closing"
    assert body["final_status"] == "approved"

    row = [a for a in store.list("approvals") if a.get("deal_id") == code][-1]
    assert row["decision"] == "approved"
    assert row["decision_notes"] == "Within policy, DSCR above floor"
    assert row["approved_by_user_id"] is not None

    actions = [e["action"] for e in store.list("audit_log") if e.get("deal_id") == code]
    assert "deal.approved" in actions
    assert "deal.closed_approved" in actions


def test_repeat_approval_is_idempotent_and_conflicting_decision_is_409():
    code = _fixture_deal(exposure_amount=400000, requested_amount=400000)
    first = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": OFFICER}).json()
    second = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": OFFICER})
    assert second.status_code == 200
    assert second.json()["approval_id"] == first["approval_id"]
    assert second.json()["replayed"] is True
    assert len([a for a in store.list("approvals") if a.get("deal_id") == code]) == 1

    clash = client.post(
        f"/api/deals/{code}/decline",
        json={
            "acting_user_email": OFFICER,
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "Changed my mind after the fact",
        },
    )
    assert clash.status_code == 409


def test_approval_is_rejected_outside_the_approval_stage():
    code = _fixture_deal(current_stage="financial_spreading")
    resp = client.post(f"/api/deals/{code}/approve", json={"acting_user_email": OFFICER})
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Adverse action (R-026/R-063)
# ---------------------------------------------------------------------------

def test_decline_requires_a_controlled_reason_code():
    code = _fixture_deal()
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={"acting_user_email": OFFICER, "reason_code": "BECAUSE_I_SAID_SO", "reason_detail": "no good reason"},
    )
    assert resp.status_code == 400
    assert "adverse-action reason code" in resp.json()["detail"]


def test_decline_requires_free_text_detail():
    code = _fixture_deal()
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={"acting_user_email": OFFICER, "reason_code": "INSUFFICIENT_DSCR", "reason_detail": "bad"},
    )
    assert resp.status_code == 400


def test_decline_stores_reason_code_detail_and_audit():
    code = _fixture_deal()
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={
            "acting_user_email": OFFICER,
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "DSCR of 0.82 is below the 1.25 policy floor",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "declined"
    assert body["adverse_action_reason_code"] == "INSUFFICIENT_DSCR"
    deal = deals_repo.get_deal(code)
    assert deal["current_status"] == "declined"
    assert deal["decline_reason_code"] == "INSUFFICIENT_DSCR"
    assert "1.25 policy floor" in deal["decline_reason_detail"]
    actions = [e["action"] for e in store.list("audit_log") if e.get("deal_id") == code]
    assert "deal.declined" in actions


def test_analyst_may_not_decline():
    code = _fixture_deal()
    resp = client.post(
        f"/api/deals/{code}/decline",
        json={
            "acting_user_email": ANALYST,
            "reason_code": "INSUFFICIENT_DSCR",
            "reason_detail": "DSCR below the policy floor by a wide margin",
        },
    )
    assert resp.status_code == 403


def test_the_reason_code_list_is_readable_for_the_dropdown():
    resp = client.get("/api/adverse_action_reasons")
    assert resp.status_code == 200
    codes = {r["reason_code"] for r in resp.json()}
    assert "INSUFFICIENT_DSCR" in codes


# ---------------------------------------------------------------------------
# Return to an earlier stage (R-047)
# ---------------------------------------------------------------------------

def test_return_sends_the_deal_back_and_reassigns_it():
    code = _fixture_deal()
    resp = client.post(
        f"/api/deals/{code}/return",
        json={
            "acting_user_email": OFFICER,
            "returned_to_stage": "financial_spreading",
            "reason": "The spread omits the 2025 interim period",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["returned_to_stage"] == "financial_spreading"
    assert body["reassigned_to_email"] == ANALYST
    deal = deals_repo.get_deal(code)
    assert deal["current_stage"] == "financial_spreading"
    assert deal["current_status"] == "returned_for_rework"
    assert [r for r in store.list("deal_returns") if r.get("deal_id") == code]


def test_return_needs_a_written_reason_and_an_earlier_stage():
    code = _fixture_deal()
    short = client.post(
        f"/api/deals/{code}/return",
        json={"acting_user_email": OFFICER, "returned_to_stage": "intake", "reason": "no"},
    )
    assert short.status_code == 400
    forward = client.post(
        f"/api/deals/{code}/return",
        json={
            "acting_user_email": OFFICER,
            "returned_to_stage": "closing",
            "reason": "Trying to push the deal forwards, which is not a return",
        },
    )
    assert forward.status_code == 400


# ---------------------------------------------------------------------------
# Business-day idle arithmetic and the register (R-034/R-057)
# ---------------------------------------------------------------------------

def test_business_days_exclude_weekends():
    # Friday 2026-01-02 -> Monday 2026-01-05 is one business day.
    assert approvals.business_days_between(
        "2026-01-02T09:00:00+00:00",
        now=datetime.datetime(2026, 1, 5, 9, 0, tzinfo=datetime.timezone.utc),
    ) == 1


def test_business_days_exclude_configured_bank_holidays():
    store.insert("business_calendar", {
        "calendar_date": "2030-06-19",
        "is_business_day": False,
        "holiday_name": "Test Holiday",
        "created_at": "2030-01-01T00:00:00+00:00",
    })
    # Tue 18th -> Thu 20th would be 2 business days; the 19th is a holiday.
    assert approvals.business_days_between(
        "2030-06-18T09:00:00+00:00",
        now=datetime.datetime(2030, 6, 20, 9, 0, tzinfo=datetime.timezone.utc),
    ) == 1


def test_idle_register_surfaces_only_deals_past_the_service_line():
    fresh = _fixture_deal(current_stage="risk_grading")
    stale = _fixture_deal(
        current_stage="risk_grading",
        last_activity_timestamp=(
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
        ).isoformat(),
    )
    body = client.get("/api/sla/idle", params={"acting_user_email": OFFICER}).json()
    codes = [d["deal_id"] for d in body["deals"]]
    assert stale in codes
    assert fresh not in codes
    assert body["threshold_business_days"] == 5
    row = next(d for d in body["deals"] if d["deal_id"] == stale)
    assert row["business_days_idle"] > 5
    assert row["escalation_owner"] == OFFICER
    assert row["blocking_items"]


def test_idle_register_withholds_borrower_names_from_anonymous_callers():
    anon = client.get("/api/sla/idle").json()
    assert anon["deals"], "the register still reports operational shape"
    assert all(d["borrower_name"] is None for d in anon["deals"])
    named = client.get("/api/sla/idle", params={"acting_user_email": OFFICER}).json()
    assert any(d["borrower_name"] for d in named["deals"])


def test_seeded_idle_deal_is_on_the_register():
    body = client.get("/api/sla/idle", params={"acting_user_email": OFFICER}).json()
    assert "DEAL-1005" in [d["deal_id"] for d in body["deals"]]


# ---------------------------------------------------------------------------
# The sla-idle-escalation workflow actually runs (workflow-authoring rule 5)
# ---------------------------------------------------------------------------

def test_escalation_runs_the_workflow_end_to_end_and_reassigns():
    code = _fixture_deal(
        current_stage="memo_drafting",
        last_activity_timestamp=(
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
        ).isoformat(),
    )
    resp = client.post(
        "/api/sla/escalate",
        json={
            "acting_user_email": OFFICER,
            "deal_code": code,
            "action": "reassign",
            "note": "Sat too long in memo drafting — moving to a free analyst",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "completed"
    assert body["action_taken"] == "reassign"
    assert body["reassigned_to_email"] == ANALYST
    assert body["idle_business_days"] > 5

    run = client.get(f"/workflows/runs/{body['run_id']}")
    assert run.status_code == 200
    assert run.json()["status"] == "completed"

    actions = [e["action"] for e in store.list("audit_log") if e.get("deal_id") == code]
    assert "sla.escalation_reassign" in actions


def test_escalation_refuses_a_deal_inside_its_sla():
    code = _fixture_deal(current_stage="memo_drafting")
    resp = client.post(
        "/api/sla/escalate",
        json={"acting_user_email": OFFICER, "deal_code": code, "action": "acknowledge", "note": "just checking"},
    )
    assert resp.status_code == 409
    assert "service line" in resp.json()["detail"]


def test_only_an_officer_may_escalate():
    code = _fixture_deal(
        last_activity_timestamp=(
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
        ).isoformat(),
    )
    resp = client.post(
        "/api/sla/escalate",
        json={"acting_user_email": ANALYST, "deal_code": code, "action": "reassign", "note": "mine now"},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# The decision desk's read surfaces
# ---------------------------------------------------------------------------

def test_approval_tier_endpoint_explains_who_may_decide():
    code = _fixture_deal(exposure_amount=750000, requested_amount=750000)
    body = client.get(f"/api/deals/{code}/approval-tier", params={"acting_user_email": ANALYST}).json()
    assert body["required_authority_level"] == "senior_credit_officer"
    assert body["caller_may_approve"] is False
    officer_view = client.get(
        f"/api/deals/{code}/approval-tier", params={"acting_user_email": OFFICER}
    ).json()
    assert officer_view["caller_may_approve"] is True


def test_approval_queue_lists_deals_awaiting_a_decision():
    code = _fixture_deal(exposure_amount=900000, requested_amount=900000)
    body = client.get("/api/approvals/queue", params={"acting_user_email": OFFICER}).json()
    row = next(d for d in body["deals"] if d["deal_id"] == code)
    assert row["required_authority_level"] == "senior_credit_officer"
    assert row["caller_may_approve"] is True
    assert body["analyst_ceiling"] == 250000


def test_no_agent_is_involved_in_any_approval_path():
    """R-023 is a system guardrail, not a prompt: this module never reaches
    for the agent runtime at all."""
    import inspect

    source = inspect.getsource(approvals)
    assert "agent_runtime" not in source
