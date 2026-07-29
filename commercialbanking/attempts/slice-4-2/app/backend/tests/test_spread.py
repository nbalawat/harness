"""spread-ratios-grade slice — financial spreading with provenance, ratios,
and risk grade."""
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


def _routed_deal():
    """Submit a deal and accept triage so it lands in financial_spreading with an owner."""
    deal = client.post("/deals/intake", json=INTAKE_BODY).json()
    deal_id = deal["deal_id"]
    client.post(f"/deals/{deal_id}/triage/run", json={})
    accept = client.post(
        f"/deals/{deal_id}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "accepted_queue": "commercial-ci-queue"},
    )
    assert accept.status_code == 200, accept.text
    assert accept.json()["current_stage"] == "financial_spreading"
    return deal_id


def test_spread_run_extracts_line_items_with_provenance():
    deal_id = _routed_deal()
    resp = client.post(f"/deals/{deal_id}/spread/run", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_key = {li["line_item_key"]: li for li in body["line_items"]}
    assert by_key["revenue"]["extracted_value"] == 8200000
    assert by_key["ebitda"]["extracted_value"] == 1450000
    assert by_key["total_debt"]["extracted_value"] == 3900000
    assert by_key["current_assets"]["extracted_value"] == 2100000
    assert by_key["current_liabilities"]["extracted_value"] == 1250000
    assert by_key["annual_debt_service"]["extracted_value"] == 980000
    for li in body["line_items"]:
        assert li["source_document_id"]
        assert li["source_location"]
        assert li["raw_extracted_text"]
    assert set(body["unextractable_line_item_keys"]) == {"net_income", "total_assets"}
    assert body["provenance_complete"] is False


def test_spread_run_unknown_deal_404():
    resp = client.post("/deals/DEAL-999999/spread/run", json={})
    assert resp.status_code == 404


def test_spread_accept_computes_ratios_and_grade():
    deal_id = _routed_deal()
    client.post(f"/deals/{deal_id}/spread/run", json={})
    resp = client.post(
        f"/deals/{deal_id}/spread/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "edits": []},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert len(body["accepted_line_item_ids"]) == 6
    assert body["current_stage"] == "credit_memo_review"
    assert round(body["ratios"]["dscr"], 4) == round(1450000 / 980000, 4)
    assert body["risk_grade"]["grade"] == 2

    ratios = client.get(f"/deals/{deal_id}/ratios").json()
    assert round(ratios["dscr"], 4) == round(1450000 / 980000, 4)
    assert round(ratios["leverage"], 4) == round(3900000 / 1450000, 4)
    assert round(ratios["current_ratio"], 4) == round(2100000 / 1250000, 4)
    by_type = {r["ratio_type"]: r for r in ratios["ratios"]}
    assert by_type["dscr"]["formula"]
    assert by_type["dscr"]["inputs"]["ebitda"] == 1450000

    grade = client.get(f"/deals/{deal_id}/risk-grade").json()
    assert grade["grade"] == 2
    assert "Grade 2" in grade["rubric_rule_applied"]
    assert grade["inputs"]["dscr"] == ratios["dscr"]
    assert grade["rubric_version"]


def test_spread_accept_without_pending_400():
    deal_id = _routed_deal()
    resp = client.post(
        f"/deals/{deal_id}/spread/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "edits": []},
    )
    assert resp.status_code == 400


def test_spread_accept_with_edit_overrides_value():
    deal_id = _routed_deal()
    run_body = client.post(f"/deals/{deal_id}/spread/run", json={}).json()
    ebitda_item = next(li for li in run_body["line_items"] if li["line_item_key"] == "ebitda")
    resp = client.post(
        f"/deals/{deal_id}/spread/accept",
        json={
            "decision": "accept",
            "accepted_by_id": "user-analyst-1",
            "edits": [{"line_item_id": ebitda_item["id"], "accepted_value": 1500000}],
        },
    )
    assert resp.status_code == 200, resp.text
    ratios = client.get(f"/deals/{deal_id}/ratios").json()
    assert round(ratios["dscr"], 4) == round(1500000 / 980000, 4)
    assert round(ratios["leverage"], 4) == round(3900000 / 1500000, 4)


def test_ratios_404_before_spread_accepted():
    deal_id = _routed_deal()
    resp = client.get(f"/deals/{deal_id}/ratios")
    assert resp.status_code == 404
    resp2 = client.get(f"/deals/{deal_id}/risk-grade")
    assert resp2.status_code == 404


def test_deal_underwriting_workflow_continues_through_spread_and_parks_at_review_spread():
    """Driving the generic engine through this slice's portion: once the
    triage gate is approved, the engine should run spread_financials ->
    persist_spread_draft and park again at the review_spread human gate."""
    import approval_flow
    import workflow_engine

    run_id = workflow_engine.start("deal-underwriting", dict(INTAKE_BODY))
    state = workflow_engine.state(run_id)
    assert state["status"] == "parked"

    triage_gate = approval_flow.pending()[-1]
    approval_flow.approve(triage_gate["id"], "user-analyst-1")
    state = workflow_engine.tick(run_id)

    assert state["status"] == "parked"
    assert "persist_spread_draft" in state["context"]
    assert state["context"]["persist_spread_draft"]["draft_status"] == "pending"
