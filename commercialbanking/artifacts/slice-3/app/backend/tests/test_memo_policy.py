"""memo-policy-compliance slice — cited credit memo and policy compliance exceptions."""
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


def _deal_ready_for_memo():
    """Submit a deal, accept triage, and accept spread so ratios/grade are on record."""
    deal = client.post("/deals/intake", json=INTAKE_BODY).json()
    deal_id = deal["deal_id"]
    client.post(f"/deals/{deal_id}/triage/run", json={})
    client.post(
        f"/deals/{deal_id}/triage/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "accepted_queue": "commercial-ci-queue"},
    )
    client.post(f"/deals/{deal_id}/spread/run", json={})
    accept = client.post(
        f"/deals/{deal_id}/spread/accept",
        json={"decision": "accept", "accepted_by_id": "user-analyst-1", "edits": []},
    )
    assert accept.status_code == 200, accept.text
    assert accept.json()["current_stage"] == "credit_memo_review"
    return deal_id


def _accepted_memo_deal():
    deal_id = _deal_ready_for_memo()
    run = client.post(f"/deals/{deal_id}/memo/run", json={})
    assert run.status_code == 200, run.text
    accept = client.post(f"/deals/{deal_id}/memo/accept", json={"decision": "accept", "accepted_by_id": "user-analyst-1"})
    assert accept.status_code == 200, accept.text
    assert accept.json()["current_stage"] == "policy_compliance_review"
    return deal_id


def test_memo_run_before_ratios_rejected():
    deal = client.post("/deals/intake", json=INTAKE_BODY).json()
    resp = client.post(f"/deals/{deal['deal_id']}/memo/run", json={})
    assert resp.status_code == 400


def test_memo_run_cites_ratios_spread_and_policy():
    deal_id = _deal_ready_for_memo()
    resp = client.post(f"/deals/{deal_id}/memo/run", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deal_id"] == deal_id
    assert body["draft_status"] == "pending"
    assert len(body["cited_ratios"]) == 3
    assert len(body["cited_spread_items"]) == 6
    assert len(body["cited_policy_rules"]) == 1
    assert body["citations_resolvable"] is True
    assert "content" in body and body["content"]
    assert all(isinstance(i, int) for i in body["cited_ratios"])


def test_memo_accept_advances_stage():
    deal_id = _deal_ready_for_memo()
    client.post(f"/deals/{deal_id}/memo/run", json={})
    resp = client.post(f"/deals/{deal_id}/memo/accept", json={"decision": "accept", "accepted_by_id": "user-analyst-1"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert body["current_stage"] == "policy_compliance_review"
    assert body["memo"]["draft_status"] == "accepted"

    memo = client.get(f"/deals/{deal_id}/memo").json()
    assert memo["accepted_by_id"] == "user-analyst-1"


def test_memo_accept_without_pending_draft_400():
    deal = client.post("/deals/intake", json=INTAKE_BODY).json()
    resp = client.post(f"/deals/{deal['deal_id']}/memo/accept", json={"decision": "accept", "accepted_by_id": "user-analyst-1"})
    assert resp.status_code == 400


def test_policy_rules_are_versioned_and_cover_required_categories():
    resp = client.get("/policy-rules")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"]
    types = {r["rule_type"] for r in body["rules"]}
    assert {"concentration", "prohibited_industry", "loan_to_value"} <= types
    assert len(body["concentration"]) >= 1
    assert len(body["prohibited_industries"]) >= 1
    assert len(body["loan_to_value"]) >= 1


def test_policy_review_run_requires_accepted_memo():
    deal_id = _deal_ready_for_memo()
    resp = client.post(f"/deals/{deal_id}/policy-review/run", json={})
    assert resp.status_code == 400


def test_policy_review_run_raises_exceptions_and_exposure():
    deal_id = _accepted_memo_deal()
    resp = client.post(f"/deals/{deal_id}/policy-review/run", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deal_id"] == deal_id
    assert "industry" in body["exposure_by_dimension"]
    assert body["deal_exposure_amount"] == 750000
    assert body["policy_version"] == "v1"
    assert len(body["rules_evaluated"]) == 3
    # This is the only active deal, so its industry is 100% of portfolio exposure —
    # necessarily above every concentration cap in the default rule set.
    assert body["open_exception_count"] >= 1
    rule_ids = {r["policy_rule_id"] for r in body["exceptions"]}
    for exc in body["exceptions"]:
        assert exc["exception_status"] == "open"
        assert exc["violation_description"]
    concentration_rule_id = next(r["id"] for r in client.get("/policy-rules").json()["concentration"])
    assert concentration_rule_id in rule_ids


def test_policy_review_accept_disposition_clears_exceptions_and_advances_stage():
    deal_id = _accepted_memo_deal()
    review = client.post(f"/deals/{deal_id}/policy-review/run", json={}).json()
    dispositions = [
        {"exception_id": exc["id"], "disposition": "waived", "waiver_reason": "Concentration accepted by senior credit officer."}
        for exc in review["exceptions"]
    ]
    resp = client.post(
        f"/deals/{deal_id}/policy-review/accept",
        json={"decision": "accept", "dispositioned_by_id": "user-officer-1", "dispositions": dispositions},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["cleared"] is True
    assert body["open_exception_count"] == 0
    assert body["current_stage"] == "approval_pending"

    exceptions = client.get(f"/deals/{deal_id}/policy-exceptions").json()
    for exc in exceptions:
        assert exc["exception_status"] == "waived"
        assert exc["waived_by_id"] == "user-officer-1"


def test_policy_review_accept_missing_disposition_400():
    deal_id = _accepted_memo_deal()
    client.post(f"/deals/{deal_id}/policy-review/run", json={})
    resp = client.post(
        f"/deals/{deal_id}/policy-review/accept",
        json={"decision": "accept", "dispositioned_by_id": "user-officer-1", "dispositions": []},
    )
    assert resp.status_code == 400
