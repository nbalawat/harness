"""tiered-approval-decisions slice — role-scoped tiered approval, decline,
and rework."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

INTAKE_BODY = {
    "borrower_name": "Northwind Manufacturing LLC",
    "industry": "manufacturing",
    "requested_amount": 750000,
    "ltv_percentage": 65,
    "collateral_description": "Owner-occupied plant and equipment",
    "submitted_by_id": "user-rm-1",
    "artifacts": [
        {
            "artifact_type": "email",
            "file_name": "application.eml",
            "content_type": "message/rfc822",
            "content": (
                "From: cfo@northwind.example\nSubject: Credit request $750k term loan\n\n"
                "Requesting a $750,000 term loan to refinance equipment. FY2025 statements attached."
            ),
        },
        {
            "artifact_type": "spreadsheet",
            "file_name": "fy2025_financials.csv",
            "content_type": "text/csv",
            "content": (
                "line_item,amount\nrevenue,8200000\nebitda,1450000\ntotal_debt,3900000\n"
                "current_assets,2100000\ncurrent_liabilities,1250000\nannual_debt_service,980000"
            ),
        },
    ],
}

SMALL_INTAKE_BODY = {
    "borrower_name": "Kestrel Signworks LLC",
    "industry": "retail",
    "requested_amount": 180000,
    "ltv_percentage": 55,
    "collateral_description": "General commercial equipment",
    "submitted_by_id": "user-rm-1",
    "artifacts": [
        {
            "artifact_type": "email",
            "file_name": "application.eml",
            "content_type": "message/rfc822",
            "content": "From: owner@kestrelsignworks.example\nSubject: Credit request $180k equipment loan\n\nRequesting a $180,000 equipment term loan. FY2025 statements attached.",
        },
        {
            "artifact_type": "spreadsheet",
            "file_name": "fy2025_financials.csv",
            "content_type": "text/csv",
            "content": (
                "line_item,amount\nrevenue,1200000\nebitda,240000\ntotal_debt,420000\n"
                "current_assets,310000\ncurrent_liabilities,190000\nannual_debt_service,150000"
            ),
        },
    ],
}


def _deal_at_policy_review(body=INTAKE_BODY):
    """Submit a deal and drive it through triage, spread and memo acceptance
    plus a policy-review run, landing at policy_compliance_review — exactly
    the state the deal is left in by the memo-policy-compliance slice's own
    acceptance script (which never calls /policy-review/accept)."""
    deal = client.post("/deals/intake", json=body).json()
    deal_id = deal["deal_id"]
    client.post(f"/deals/{deal_id}/triage/run", json={})
    client.post(
        f"/deals/{deal_id}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "accepted_queue": "commercial-ci-queue"},
    )
    client.post(f"/deals/{deal_id}/spread/run", json={})
    client.post(f"/deals/{deal_id}/spread/accept", json={"decision": "accept", "accepted_by_id": "user-analyst-1", "edits": []})
    client.post(f"/deals/{deal_id}/memo/run", json={})
    accept = client.post(f"/deals/{deal_id}/memo/accept", json={"decision": "accept", "accepted_by_id": "user-analyst-1"})
    assert accept.status_code == 200, accept.text
    client.post(f"/deals/{deal_id}/policy-review/run", json={})
    deal_after = client.get(f"/deals/{deal_id}").json()
    assert deal_after["current_stage"] == "policy_compliance_review"
    return deal_id


def test_approval_tier_derived_from_exposure():
    deal_id = _deal_at_policy_review()
    resp = client.get(f"/deals/{deal_id}/approval-tier")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["required_authority_tier"] == "senior_credit_officer"
    assert body["exposure_amount"] == 750000
    assert "tier_rule_applied" in body


def test_approval_tier_small_deal_is_analyst_tier():
    deal = client.post("/deals/intake", json=SMALL_INTAKE_BODY).json()
    resp = client.get(f"/deals/{deal['deal_id']}/approval-tier")
    assert resp.json()["required_authority_tier"] == "analyst"


def test_approval_refused_when_authority_below_tier():
    deal_id = _deal_at_policy_review()
    resp = client.post(
        "/approvals",
        json={
            "deal_id": deal_id,
            "decision": "approve",
            "decided_by_id": "user-analyst-1",
            "decision_notes": "Analyst attempting an approval above their $250k authority",
        },
    )
    assert resp.status_code == 403, resp.text
    assert "authority" in resp.json()["detail"].lower()
    # refusal must not have advanced the deal
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_approval_succeeds_for_authorized_officer_and_advances_to_closing():
    deal_id = _deal_at_policy_review()
    # confirm there's an open policy exception before approval (100% industry
    # concentration on a lone active deal breaches the concentration cap)
    exceptions_before = client.get(f"/deals/{deal_id}/policy-exceptions").json()
    assert any(e["exception_status"] == "open" for e in exceptions_before)

    resp = client.post(
        "/approvals",
        json={
            "deal_id": deal_id,
            "decision": "approve",
            "decided_by_id": "user-officer-1",
            "decision_notes": "Within senior credit officer authority; grade and exceptions reviewed",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] is True
    assert body["decided_by_id"] == "user-officer-1"
    assert body["current_stage"] == "closing"

    deal_after = client.get(f"/deals/{deal_id}").json()
    assert deal_after["current_stage"] == "closing"
    exceptions_after = client.get(f"/deals/{deal_id}/policy-exceptions").json()
    assert all(e["exception_status"] != "open" for e in exceptions_after)


def test_decline_requires_adverse_action_reason_and_records_it():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/decline",
        json={"decided_by_id": "user-officer-1", "adverse_action_reason": "DSCR below policy minimum of 1.20x on the most recent fiscal year"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["declined"] is True
    assert body["adverse_action_reason"].startswith("DSCR below policy minimum")
    assert body["decided_by_id"] == "user-officer-1"
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "declined"


def test_decline_missing_reason_rejected():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(f"/deals/{deal_id}/decline", json={"decided_by_id": "user-officer-1", "adverse_action_reason": "  "})
    assert resp.status_code == 400


def test_ensure_demo_second_deal_noops_against_the_shared_store():
    """By this point in the shared test session the store has many deals, so
    the guard's "exactly one deal, and it's DEAL-001" check must no-op."""
    import ext_approvals

    before = len(client.get("/deals").json())
    ext_approvals._ensure_demo_second_deal()
    assert len(client.get("/deals").json()) == before


def test_ensure_demo_second_deal_seeds_deal_002_from_a_lone_deal_001():
    """Exercises the real insert branch in true isolation — a fresh db.Store
    swapped in for the module's global `store` reference for the duration of
    this test only — so it never touches the shared module-level store every
    other test in this file (and every other test file in the same pytest
    session) depends on. Reproduces exactly the shape a freshly booted app
    is in immediately after the intake-triage-pipeline slice's own
    acceptance script runs: one deal, DEAL-001, and nothing else — the state
    _ensure_demo_second_deal()'s guard exists to detect."""
    import db
    import ext_approvals
    import ext_deals

    fresh_store = db.Store()
    fresh_store.insert(
        "deals",
        {
            "deal_id": "DEAL-001",
            "borrower_name": "Northwind Manufacturing LLC",
            "industry": "manufacturing",
            "requested_amount": 750000,
            "current_stage": "policy_compliance_review",
            "status": "active",
            "submitted_by_id": "user-rm-1",
        },
    )
    original_store = ext_approvals.store
    original_deals_store = ext_deals.store
    ext_approvals.store = fresh_store
    ext_deals.store = fresh_store
    try:
        ext_approvals._ensure_demo_second_deal()
        deals = fresh_store.list("deals")
        assert [d["deal_id"] for d in deals] == ["DEAL-001", "DEAL-002"]
        second = deals[1]
        assert second["borrower_name"] == "Sunrise Hospitality Group LLC"
        assert second["current_stage"] == "intake"
        assert second["status"] == "active"
        # Seeded through the intake slice's own handler, so it is a real
        # application with its artifacts stored through blob_store.
        artifacts = [a for a in fresh_store.list("source_artifacts") if a["deal_id"] == "DEAL-002"]
        assert len(artifacts) == 2

        # Guard is idempotent: calling it again with DEAL-002 now present
        # must not seed a third deal.
        ext_approvals._ensure_demo_second_deal()
        assert len(fresh_store.list("deals")) == 2
    finally:
        ext_approvals.store = original_store
        ext_deals.store = original_deals_store


def test_rework_returns_deal_to_an_earlier_stage_with_reason_and_assignee():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/rework",
        json={
            "decided_by_id": "user-officer-1",
            "rework_reason": "Re-spread with the guarantor's personal debt schedule included.",
            "rework_assigned_to_id": "user-analyst-1",
            "returned_to_stage": "financial_spreading",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["returned_to_stage"] == "financial_spreading"
    assert body["rework_assigned_to_id"] == "user-analyst-1"
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "financial_spreading"


def test_rework_rejects_a_later_stage_than_the_deals_current_one():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/rework",
        json={
            "decided_by_id": "user-officer-1",
            "rework_reason": "Not actually earlier.",
            "rework_assigned_to_id": "user-analyst-1",
            "returned_to_stage": "approval_pending",
        },
    )
    assert resp.status_code == 400
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_rework_rejected_on_a_terminal_deal():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    decline = client.post(
        f"/deals/{deal_id}/decline",
        json={"decided_by_id": "user-officer-1", "adverse_action_reason": "Adverse action for terminal-rework test."},
    )
    assert decline.status_code == 200, decline.text
    resp = client.post(
        f"/deals/{deal_id}/rework",
        json={
            "decided_by_id": "user-officer-1",
            "rework_reason": "Too late.",
            "rework_assigned_to_id": "user-analyst-1",
            "returned_to_stage": "intake",
        },
    )
    assert resp.status_code == 400


def test_generic_engine_rejection_leaves_deal_at_the_same_stage_not_regressed():
    """record_rework_return, driven with no decision_details (exactly how
    the generic workflow_engine invokes it as check_spread_accepted's
    on_false target), must go through deal_state.machine like every sibling
    apply_*_decision handler's reject branch does — a same-stage redraft
    loop, never an unrequested deeper regression."""
    import ext_approvals

    deal = client.post("/deals/intake", json=SMALL_INTAKE_BODY).json()
    deal_id = deal["deal_id"]
    client.post(f"/deals/{deal_id}/triage/run", json={})
    client.post(
        f"/deals/{deal_id}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "accepted_queue": "commercial-ci-queue"},
    )
    deal_after_routing = client.get(f"/deals/{deal_id}").json()
    assert deal_after_routing["current_stage"] == "financial_spreading"

    result = ext_approvals.record_rework_return({"record_intake": {"deal_id": deal_id}})
    assert result["returned_to_stage"] == "financial_spreading"
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "financial_spreading"


def test_deal_underwriting_workflow_runs_end_to_end_through_approval_and_closing():
    """Driving the generic engine end to end: once every prior human gate is
    approved (including this slice's own approval_decision gate), the run
    should reach derive_approval_tier, record_approval_decision and
    advance_deal_to_closing, and finish completed at stage 'closing'."""
    import approval_flow
    import workflow_engine

    run_id = workflow_engine.start("deal-underwriting", dict(SMALL_INTAKE_BODY))
    state = workflow_engine.state(run_id)
    for _ in range(8):
        if state["status"] != "parked":
            break
        pending = approval_flow.pending()
        if not pending:
            break
        approval_flow.approve(pending[-1]["id"], "user-officer-1")
        state = workflow_engine.tick(run_id)

    assert state["status"] == "completed"
    assert state["context"]["derive_approval_tier"]["required_authority_tier"] == "analyst"
    assert state["context"]["record_approval_decision"]["decision"] == "approved"
    assert state["context"]["advance_to_closing"]["new_stage"] == "closing"


def test_rework_without_a_named_stage_returns_the_deal_one_stage_back():
    """The Approvals screen's rework control asks only for a reason and an
    assignee — the server must fill in the nearest earlier stage rather than
    422ing on a missing target (REQ-041)."""
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/rework",
        json={
            "decided_by_id": "user-officer-1",
            "rework_reason": "Re-run the memo with the updated guarantor schedule.",
            "rework_assigned_to_id": "user-analyst-1",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["returned_to_stage"] == "credit_memo_review"
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "credit_memo_review"


def test_decline_refused_for_a_user_holding_no_approval_authority():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/decline",
        json={"decided_by_id": "user-rm-1", "adverse_action_reason": "RM trying to decline their own submission."},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_rework_refused_for_a_user_holding_no_approval_authority():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        f"/deals/{deal_id}/rework",
        json={"decided_by_id": "nobody-at-all", "rework_reason": "Unauthorized.", "rework_assigned_to_id": "user-analyst-1"},
    )
    assert resp.status_code == 403
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_decline_through_the_approvals_endpoint_is_redirected_to_the_decline_endpoint():
    """A decline must carry an adverse-action reason (REQ-040); POST /approvals
    has no field for one, so it must refuse rather than persist a 'declined'
    approval row against a deal left silently active."""
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "decline", "decided_by_id": "user-officer-1", "decision_notes": "no reason field here"},
    )
    assert resp.status_code == 400
    assert "adverse_action_reason" in resp.json()["detail"]
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"
    assert not [a for a in client.get("/approvals").json() if a["deal_id"] == deal_id]


def test_unknown_decision_verb_is_rejected_not_stored_verbatim():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "maybe-later", "decided_by_id": "user-officer-1"},
    )
    assert resp.status_code == 400
    assert not [a for a in client.get("/approvals").json() if a["deal_id"] == deal_id]


def test_a_session_may_only_record_decisions_under_its_own_name():
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    token = client.post("/auth/login", json={"username": "user-analyst-1"}).json()["token"]
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "approve", "decided_by_id": "user-officer-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403
    assert "own name" in resp.json()["detail"]


def test_relationship_manager_session_sees_only_its_own_deals():
    """REQ-048 row-level scoping on the pipeline board: an authenticated
    relationship manager is scoped to their own submissions, while the
    unauthenticated acceptance path every earlier slice uses stays unscoped."""
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)  # submitted_by_id user-rm-1
    other = client.post("/deals/intake", json={**SMALL_INTAKE_BODY, "borrower_name": "Foreign RM Deal LLC", "submitted_by_id": "user-rm-2"}).json()

    rm_token = client.post("/auth/login", json={"username": "user-rm-1"}).json()["token"]
    scoped = client.get("/deals", headers={"Authorization": f"Bearer {rm_token}"}).json()
    scoped_ids = [d["deal_id"] for d in scoped]
    assert deal_id in scoped_ids
    assert other["deal_id"] not in scoped_ids
    assert client.get(f"/deals/{other['deal_id']}", headers={"Authorization": f"Bearer {rm_token}"}).status_code == 404

    officer_token = client.post("/auth/login", json={"username": "user-officer-1"}).json()["token"]
    officer_ids = [d["deal_id"] for d in client.get("/deals", headers={"Authorization": f"Bearer {officer_token}"}).json()]
    assert other["deal_id"] in officer_ids

    unscoped_ids = [d["deal_id"] for d in client.get("/deals").json()]
    assert other["deal_id"] in unscoped_ids


def test_rework_through_the_approvals_endpoint_is_refused():
    """POST /approvals records approvals only: a rework verb there would
    persist a decision row that nothing acts on, un-authority-checked."""
    deal_id = _deal_at_policy_review(SMALL_INTAKE_BODY)
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "return_for_rework", "decided_by_id": "whoever"},
    )
    assert resp.status_code == 400
    assert "rework" in resp.json()["detail"]
    assert not [a for a in client.get("/approvals").json() if a["deal_id"] == deal_id]
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_approval_at_a_stage_that_cannot_accept_one_writes_nothing():
    """An approval the deal's stage cannot accept must be refused before any
    approvals row or audit entry is written (409, not a persisted 'approved'
    record against an un-approved deal)."""
    deal = client.post("/deals/intake", json=SMALL_INTAKE_BODY).json()
    deal_id = deal["deal_id"]
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "approve", "decided_by_id": "user-officer-1"},
    )
    assert resp.status_code == 409, resp.text
    assert not [a for a in client.get("/approvals").json() if a["deal_id"] == deal_id]
    audit = [e for e in client.get("/api/audit_trail").json() if e["deal_id"] == deal_id]
    assert not [e for e in audit if str(e["event_type"]).startswith("approval.")]
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "intake"


def test_approval_authority_cannot_be_minted_through_the_generic_table_api():
    """`users` is writable through main.py's generic /api/{table}; the
    authority gate must therefore be code, not a stored row (REQ-034)."""
    deal_id = _deal_at_policy_review()
    client.post("/api/users", json={"username": "mallory", "role": "credit_officer", "approval_authority_tier": "credit_committee"})
    resp = client.post(
        "/approvals",
        json={"deal_id": deal_id, "decision": "approve", "decided_by_id": "mallory"},
    )
    assert resp.status_code == 403, resp.text
    assert client.get(f"/deals/{deal_id}").json()["current_stage"] == "policy_compliance_review"


def test_rework_target_stages_are_state_machine_events_not_ad_hoc_jumps():
    import deal_state

    assert deal_state.TRANSITIONS["policy_compliance_review"]["return_to_financial_spreading"] == "financial_spreading"
    # never forwards, and never out of a terminal stage
    assert "return_to_approval_pending" not in deal_state.TRANSITIONS["policy_compliance_review"]
    assert "closing" not in deal_state.TRANSITIONS
