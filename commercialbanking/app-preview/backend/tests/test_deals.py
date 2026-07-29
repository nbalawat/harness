"""intake-triage-pipeline slice — intake, agent triage, and the pipeline board."""
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


def test_intake_creates_deal_and_stores_artifacts():
    body = _submit_deal()
    assert body["deal_id"].startswith("DEAL-")
    assert body["borrower_name"] == "Northwind Manufacturing LLC"
    assert body["current_stage"] == "intake"
    assert "intake" in body
    assert len(body["artifacts"]) == 2
    assert {a["artifact_type"] for a in body["artifacts"]} == {"email", "spreadsheet"}


def test_deals_list_shows_borrower_and_stage():
    deal = _submit_deal()
    rows = client.get("/deals").json()
    match = next(r for r in rows if r["deal_id"] == deal["deal_id"])
    assert match["borrower_name"] == deal["borrower_name"]
    assert match["current_stage"] == "intake"


def test_triage_run_proposes_classification():
    deal = _submit_deal()
    resp = client.post(f"/deals/{deal['deal_id']}/triage/run", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["request_type"] == "refinance"
    assert body["product_type"] == "term_loan"
    assert body["underwriting_suitable"] is True
    # email + spreadsheet cover loan_application_email + financial_statements only
    assert set(body["missing_documents"]) == {"tax_returns", "collateral_documentation"}
    assert body["recommended_queue"] == "commercial-ci-queue"
    assert body["draft_status"] == "pending"
    assert body["draft"]["status"] == "pending"


def test_triage_run_unknown_deal_404():
    resp = client.post("/deals/DEAL-999999/triage/run", json={})
    assert resp.status_code == 404


def test_triage_accept_routes_deal_and_advances_stage():
    deal = _submit_deal()
    deal_id = deal["deal_id"]
    triage = client.post(f"/deals/{deal_id}/triage/run", json={}).json()
    resp = client.post(
        f"/deals/{deal_id}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "accepted_queue": "commercial-ci-queue"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert body["queue"] == "commercial-ci-queue"
    assert body["current_stage"] == "financial_spreading"
    assert body["assigned_owner_id"]

    # the deal itself now reflects the new stage and owner
    updated = next(r for r in client.get("/deals").json() if r["deal_id"] == deal_id)
    assert updated["current_stage"] == "financial_spreading"
    assert updated["assigned_owner_id"] == body["assigned_owner_id"]
    assert triage["recommended_queue"] == "commercial-ci-queue"


def test_triage_accept_without_pending_draft_400():
    deal = _submit_deal()
    resp = client.post(
        f"/deals/{deal['deal_id']}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1"},
    )
    assert resp.status_code == 400


def test_deal_underwriting_workflow_runs_this_slices_portion_and_parks():
    """Driving the full generic workflow should also work end to end through
    this slice's nodes (record_intake -> triage_request -> persist_triage_draft)
    and park at the human review_triage gate, per the workflow-engine contract."""
    import workflow_engine

    run_id = workflow_engine.start("deal-underwriting", dict(INTAKE_BODY))
    state = workflow_engine.state(run_id)
    assert state["status"] == "parked"
    assert "persist_triage_draft" in state["context"]
    assert state["context"]["persist_triage_draft"]["draft_status"] == "pending"
