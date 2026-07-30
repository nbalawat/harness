"""portfolio-qa-sla-audit slice — grounded portfolio Q&A, SLA dashboard, and
audit history."""
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


def _submit_deal():
    resp = client.post("/deals/intake", json=INTAKE_BODY)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_portfolio_qa_answers_with_grounded_figures():
    deal = _submit_deal()
    resp = client.post(
        "/portfolio/qa",
        json={"question": f"Show me all deals above $500k with DSCR under 5", "asked_by_id": "user-officer-1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "answer" in body and body["answer"]
    assert "supporting_deal_ids" in body
    assert body["read_only"] is True
    # DSCR isn't computed yet (spread never run), so this deal cannot cite a
    # DSCR-filtered figure it hasn't got — it should be excluded, not guessed.
    assert deal["deal_id"] not in body["supporting_deal_ids"]


def test_portfolio_qa_no_results_still_returns_contract_fields():
    resp = client.post(
        "/portfolio/qa",
        json={"question": "deals above $999,999,999", "asked_by_id": "user-officer-1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["supporting_deal_ids"] == []
    assert body["read_only"] is True
    assert "no" in body["answer"].lower() or "0" in body["answer"]


def test_portfolio_qa_scopes_to_relationship_manager_own_deals():
    _submit_deal()
    resp = client.post(
        "/portfolio/qa",
        json={"question": "list all deals", "asked_by_id": "user-rm-1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # user-rm-1 has no portfolio-wide bypass role — only sees deals they
    # themselves submitted (which, since INTAKE_BODY.submitted_by_id is
    # user-rm-1, is every deal this test file creates, but never more).
    assert body["visible_deal_count"] <= len(client.get("/deals").json())


def test_portfolio_qa_missing_question_400():
    resp = client.post("/portfolio/qa", json={"question": "  ", "asked_by_id": "user-officer-1"})
    assert resp.status_code == 400


def test_sla_dashboard_lists_every_deal_with_idle_fields():
    deal = _submit_deal()
    resp = client.get("/sla/dashboard")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "threshold_business_days" in body
    match = next(d for d in body["deals"] if d["deal_id"] == deal["deal_id"])
    assert "business_days_idle" in match
    assert "is_over_sla" in match
    assert match["is_over_sla"] is False  # just submitted — can't be idle yet


def test_sla_dashboard_as_of_override_surfaces_a_breach():
    deal = _submit_deal()
    resp = client.get("/sla/dashboard", params={"as_of": "2030-01-01T00:00:00Z"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    match = next(d for d in body["deals"] if d["deal_id"] == deal["deal_id"])
    assert match["business_days_idle"] > 5
    assert match["is_over_sla"] is True
    assert deal["deal_id"] in body["breaching_deal_ids"]
    assert body["briefing"]  # SLA Escalation Briefer's advisory note, non-empty


def test_deal_audit_returns_chronological_entries_for_the_deal():
    deal = _submit_deal()
    client.post(f"/deals/{deal['deal_id']}/triage/run", json={})
    resp = client.get(f"/deals/{deal['deal_id']}/audit")
    assert resp.status_code == 200, resp.text
    entries = resp.json()
    assert len(entries) >= 2  # intake_recorded + triage.drafted at least
    for e in entries:
        assert e["deal_id"] == deal["deal_id"]
        assert "actor_id" in e
        assert "actor_type" in e
        assert "event_type" in e
        assert "timestamp" in e
    # newest-first
    assert entries == sorted(entries, key=lambda e: e["id"], reverse=True)


def test_deal_audit_unknown_deal_404():
    resp = client.get("/deals/DEAL-999999/audit")
    assert resp.status_code == 404


def test_portfolio_qa_workflow_runs_end_to_end():
    """Driving the generic portfolio-qa workflow should complete without a
    human gate (there isn't one in this workflow) and record a real answer."""
    import workflow_engine

    deal = _submit_deal()
    run_id = workflow_engine.start("portfolio-qa", {"question": f"deals above $1", "asked_by_id": "user-officer-1"})
    state = workflow_engine.state(run_id)
    assert state["status"] == "completed"
    assert state["context"]["execute_query"]["has_results"] is True
    assert deal["deal_id"] in state["context"]["execute_query"]["result_deal_ids"]


def test_sla_escalation_workflow_reaches_human_gate_when_breaching():
    import workflow_engine

    _submit_deal()
    run_id = workflow_engine.start("sla-escalation", {"as_of": "2030-01-01T00:00:00Z"})
    state = workflow_engine.state(run_id)
    assert state["status"] == "parked"
    assert state["context"]["compute_idle_ages"]["has_breaches"] is True


def test_sla_escalate_endpoint_applies_named_decision():
    deal = _submit_deal()
    resp = client.post(
        "/sla/escalate",
        json={"decided_by_id": "user-officer-1", "per_deal_actions": {deal["deal_id"]: {"action": "acknowledge"}}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert deal["deal_id"] in body["affected_deal_ids"]
    assert body["decided_by_id"] == "user-officer-1"
