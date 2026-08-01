"""Tests for slice `spread-ratios-and-risk-grade`: the Financial Spreading
Agent, spread acceptance, deterministic ratio computation, and risk grading."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

ANALYST = "analyst@bank.test"


def _new_deal_with_required_documents(borrower_name):
    created = client.post(
        "/api/deals",
        json={
            "borrower_name": borrower_name,
            "borrower_industry": "manufacturing",
            "requested_amount": 300000,
            "exposure_amount": 300000,
            "acting_user_email": "rm@bank.test",
        },
    ).json()
    code = created["deal_code"]
    for doc_type in ("balance_sheet", "income_statement", "tax_return"):
        resp = client.post(
            f"/api/deals/{code}/documents",
            json={"acting_user_email": ANALYST, "document_type": doc_type, "file_name": f"{doc_type}.pdf"},
        )
        assert resp.status_code == 201
    return code


def test_fixture_deal_seeded_with_documents():
    deal = client.get("/api/deals/DEAL-1002").json()
    assert deal["deal_code"] == "DEAL-1002"
    assert deal["borrower_name"]
    docs = client.get("/api/deals/DEAL-1002/documents").json()
    types = {d["document_type"] for d in docs}
    assert {"balance_sheet", "income_statement", "tax_return"} <= types


def test_unknown_deal_404s():
    resp = client.post(
        "/api/deals/DEAL-9999/agents/financial-spreading/run", json={"acting_user_email": ANALYST}
    )
    assert resp.status_code == 404
    assert client.get("/api/deals/DEAL-9999").status_code == 404


def test_spreading_requires_authorized_role():
    import identity as identity_module

    identity_module.resolve_user("guest2@bank.test", default_role="viewer")
    resp = client.post(
        "/api/deals/DEAL-1002/agents/financial-spreading/run",
        json={"acting_user_email": "guest2@bank.test"},
    )
    assert resp.status_code == 403


def test_spreading_blocked_until_required_documents_attached():
    created = client.post(
        "/api/deals",
        json={
            "borrower_name": "Undocumented Co",
            "borrower_industry": "retail",
            "requested_amount": 150000,
            "exposure_amount": 150000,
            "acting_user_email": "rm@bank.test",
        },
    ).json()
    resp = client.post(
        f"/api/deals/{created['deal_code']}/agents/financial-spreading/run",
        json={"acting_user_email": ANALYST},
    )
    assert resp.status_code == 409


def test_accept_without_prior_run_is_rejected():
    code = _new_deal_with_required_documents("No Run Yet Co")
    resp = client.post(f"/api/deals/{code}/spread/accept", json={"acting_user_email": ANALYST, "action": "accept"})
    assert resp.status_code == 409


def test_run_then_accept_computes_ratios_and_grade():
    code = _new_deal_with_required_documents("Full Flow Co")

    run_resp = client.post(f"/api/deals/{code}/agents/financial-spreading/run", json={"acting_user_email": ANALYST})
    assert run_resp.status_code == 200
    run_body = run_resp.json()
    for field in ("rows", "citations", "unextractable", "template_version", "document_id"):
        assert field in run_body
    assert run_body["rows"], "expected extracted line items"
    assert len(run_body["rows"]) == len(run_body["citations"])
    for citation in run_body["citations"]:
        assert citation["document_id"] is not None
        assert citation.get("cell_locator") or citation.get("section")
    unextractable_keys = {u["line_item_key"] for u in run_body["unextractable"]}
    row_keys = {r["line_item_key"] for r in run_body["rows"]}
    assert not (unextractable_keys & row_keys), "unextractable figures must never also appear in rows"

    accept_resp = client.post(
        f"/api/deals/{code}/spread/accept", json={"acting_user_email": ANALYST, "action": "accept"}
    )
    assert accept_resp.status_code == 200
    accept_body = accept_resp.json()
    assert accept_body["status"] == "accepted"
    assert accept_body["accepted_by"] == ANALYST
    assert accept_body["current_stage"] == "memo_drafting"

    ratios_resp = client.get(f"/api/deals/{code}/ratios")
    assert ratios_resp.status_code == 200
    ratios_body = ratios_resp.json()
    ratio_types = {r["ratio_type"] for r in ratios_body["ratios"]}
    assert ratio_types == {"dscr", "leverage", "current_ratio"}
    for r in ratios_body["ratios"]:
        assert "numerator" in r and "denominator" in r and "result" in r

    grade_resp = client.get(f"/api/deals/{code}/risk-grade")
    assert grade_resp.status_code == 200
    grade_body = grade_resp.json()
    assert grade_body["grade"] in ("A", "B", "C", "D")
    assert grade_body["rubric_version"]
    assert grade_body["band_hit"]

    deal = client.get(f"/api/deals/{code}").json()
    assert deal["risk_grade"] == grade_body["grade"]
    assert deal["current_stage"] == "memo_drafting"


def test_reject_does_not_compute_ratios_or_advance_stage():
    code = _new_deal_with_required_documents("Reject Flow Co")
    client.post(f"/api/deals/{code}/agents/financial-spreading/run", json={"acting_user_email": ANALYST})
    resp = client.post(
        f"/api/deals/{code}/spread/accept",
        json={"acting_user_email": ANALYST, "action": "reject", "note": "figures look stale"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"

    assert client.get(f"/api/deals/{code}/ratios").status_code == 404
    assert client.get(f"/api/deals/{code}/risk-grade").status_code == 404
    deal = client.get(f"/api/deals/{code}").json()
    assert deal["current_stage"] != "memo_drafting"


def test_ratios_and_risk_grade_404_before_acceptance():
    code = _new_deal_with_required_documents("Not Yet Graded Co")
    assert client.get(f"/api/deals/{code}/ratios").status_code == 404
    assert client.get(f"/api/deals/{code}/risk-grade").status_code == 404
