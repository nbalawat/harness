"""Tests for slice `deal-intake-and-triage`: deal submission, the Intake
Triage Agent, and the pipeline board."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def _submit_deal(borrower_name="Harborline Freight", industry="trucking", amount=400000):
    return client.post(
        "/api/deals",
        json={
            "borrower_name": borrower_name,
            "borrower_industry": industry,
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": "rm@bank.test",
        },
    )


def test_create_deal_enters_intake():
    resp = _submit_deal()
    assert resp.status_code == 201
    body = resp.json()
    assert body["borrower_name"] == "Harborline Freight"
    assert body["current_stage"] == "intake"
    assert body["deal_code"].startswith("DEAL-")


def test_create_deal_requires_authorized_role():
    import identity as identity_module

    identity_module.resolve_user("guest@bank.test", default_role="viewer")
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": "Some Borrower",
            "borrower_industry": "retail",
            "requested_amount": 10000,
            "exposure_amount": 10000,
            "acting_user_email": "guest@bank.test",
        },
    )
    assert resp.status_code == 403


def test_pipeline_lists_created_deal():
    created = _submit_deal(borrower_name="Pipeline Test Co").json()
    resp = client.get("/api/pipeline")
    assert resp.status_code == 200
    body = resp.json()
    codes = [d["deal_code"] for d in body["deals"]]
    assert created["deal_code"] in codes
    assert "intake" in body["columns"]


def test_triage_run_then_accept_routes_deal():
    deal = _submit_deal(borrower_name="Triage Flow Co").json()
    code = deal["deal_code"]

    run_resp = client.post(f"/api/deals/{code}/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"})
    assert run_resp.status_code == 200
    run_body = run_resp.json()
    for field in ("classification", "missing_documents", "recommended_queue", "confidence_score"):
        assert field in run_body
    assert 0 <= run_body["confidence_score"] <= 1
    assert run_body["recommended_queue"] in ("standard_underwriting_queue", "complex_credit_queue")

    accept_resp = client.post(f"/api/deals/{code}/triage/accept", json={"acting_user_email": "analyst@bank.test"})
    assert accept_resp.status_code == 200
    accept_body = accept_resp.json()
    assert accept_body["current_stage"] == "document_extraction"
    assert "queue_name" in accept_body

    pipeline = client.get("/api/pipeline").json()
    routed = next(d for d in pipeline["deals"] if d["deal_code"] == code)
    assert routed["current_stage"] == "document_extraction"
    assert routed["assigned_to_user_id"] is not None


def test_accept_without_prior_triage_run_is_rejected():
    deal = _submit_deal(borrower_name="No Triage Yet Co").json()
    code = deal["deal_code"]
    resp = client.post(f"/api/deals/{code}/triage/accept", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 409


def test_unknown_deal_404s():
    resp = client.post("/api/deals/DEAL-9999/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 404


def test_unknown_user_cannot_mutate():
    """Default-deny: an email that resolves to no stored user gets nothing."""
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": "Ghost Co",
            "borrower_industry": "retail",
            "requested_amount": 10000,
            "exposure_amount": 10000,
            "acting_user_email": "nobody@evil.test",
        },
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_relationship_manager_cannot_run_triage():
    deal = _submit_deal(borrower_name="Role Split Co").json()
    resp = client.post(
        f"/api/deals/{deal['deal_code']}/agents/intake-triage/run",
        json={"acting_user_email": "rm@bank.test"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_deal_book_is_scoped_for_a_relationship_manager():
    import identity as identity_module

    _submit_deal(borrower_name="Scoping Co")
    rm = identity_module.find_user("rm@bank.test")
    scoped = client.get("/api/deals", params={"acting_user_email": "rm@bank.test"})
    assert scoped.status_code == 200
    assert scoped.json(), "the RM should still see the deals it filed"
    assert all(d["created_by_user_id"] == rm["id"] for d in scoped.json())

    officer = client.get("/api/deals", params={"acting_user_email": "officer@bank.test"})
    assert officer.status_code == 200
    assert len(officer.json()) >= len(scoped.json())


def test_workflow_routes_are_not_shadowed_by_the_table_catch_all():
    """The /workflows router is mounted before the generic /api/{table}
    catch-all, so its routes resolve to the workflow engine."""
    resp = client.get("/workflows")
    assert resp.status_code == 200
    assert "workflows" in resp.json()


def test_missing_documents_reflects_attached_documents():
    deal = _submit_deal(borrower_name="Docs Co").json()
    code = deal["deal_code"]
    run_body = client.post(f"/api/deals/{code}/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"}).json()
    assert set(run_body["missing_documents"]) == {"balance_sheet", "income_statement", "tax_return"}
