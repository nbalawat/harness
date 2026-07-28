"""Slice 1 — case intake and the deterministic completeness check."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import kyc_policy as policy  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

COMPLETE_PACKAGE = [
    "certificate_of_incorporation",
    "register_of_directors",
    "beneficial_ownership_declaration",
    "proof_of_registered_address",
]

SIMPLE_ATTRS = {"ownership_chain_depth": 1, "regulated_industry": False, "cross_border_expected": False}
SIMPLE_FACTORS = {
    "jurisdiction": "standard",
    "entity_structure": "simple",
    "industry": "other",
    "sanctions_screening": "clear",
    "expected_activity": "domestic_only",
}


def submit(reference, documents, attributes=None, factors=None, client_name="Test Corp Ltd"):
    return client.post(
        "/cases",
        json={
            "client_reference": reference,
            "client_name": client_name,
            "entity_type": "corporate",
            "submitted_by": "ana.analyst",
            "documents": documents,
            "attributes": attributes if attributes is not None else SIMPLE_ATTRS,
            "risk_factors": factors if factors is not None else SIMPLE_FACTORS,
        },
    )


def test_checklist_published_with_version():
    body = client.get("/checklist").json()
    assert body["version"] == policy.DOCUMENT_CHECKLIST_VERSION
    types = [d["document_type"] for d in body["required_for_every_corporate_case"]]
    conditional = [d["document_type"] for d in body["conditionally_required"]]
    assert types == COMPLETE_PACKAGE
    assert conditional == ["structure_chart", "operating_license", "expected_activity_questionnaire"]
    assert body["waivable_by_analyst"] is False


def test_complete_package_becomes_ready():
    body = submit("T-COMPLETE-1", COMPLETE_PACKAGE).json()
    assert body["status"] == "ready"
    assert body["case_reference"] == "t-complete-1"
    assert body["case_ready_timestamp"]
    assert body["completeness_passed_at"] == body["case_ready_timestamp"]
    assert body["missing_documents"] == []
    assert body["document_checklist_version"] == policy.DOCUMENT_CHECKLIST_VERSION
    assert body["workflow_status"] == "completed"


def test_incomplete_package_is_returned_with_itemised_missing_list():
    body = submit(
        "T-RETURNED-1",
        ["certificate_of_incorporation", "proof_of_registered_address"],
        attributes={"ownership_chain_depth": 3, "regulated_industry": True, "cross_border_expected": False},
    ).json()
    assert body["status"] == "returned"
    assert body["case_ready_timestamp"] is None
    assert set(body["missing_documents"]) == {
        "register_of_directors",
        "beneficial_ownership_declaration",
        "structure_chart",
        "operating_license",
    }
    assert "expected_activity_questionnaire" not in body["missing_documents"]


def test_conditional_trigger_cross_border_only():
    body = submit(
        "T-RETURNED-2",
        COMPLETE_PACKAGE,
        attributes={"ownership_chain_depth": 1, "regulated_industry": False, "cross_border_expected": True},
    ).json()
    assert body["status"] == "returned"
    assert body["missing_documents"] == ["expected_activity_questionnaire"]


def test_worklist_and_case_detail_are_addressable_by_reference():
    rows = client.get("/cases").json()
    references = [r["case_reference"] for r in rows]
    assert "t-complete-1" in references and "t-returned-1" in references

    detail = client.get("/cases/T-RETURNED-1")
    assert detail.status_code == 200
    assert detail.json()["status"] == "returned"
    assert "register_of_directors" in detail.json()["missing_documents"]
    assert client.get("/cases/does-not-exist").status_code == 404


def test_no_role_may_waive_a_required_document():
    for user in ("ana.analyst", "sam.senior", "cora.compliance"):
        response = client.post(
            "/cases/T-RETURNED-1/waive-document",
            json={"document_type": "register_of_directors", "acting_user": user},
        )
        assert response.status_code == 403
        assert "compliance" in response.json()["detail"].lower()
    still_missing = client.get("/cases/T-RETURNED-1").json()["missing_documents"]
    assert "register_of_directors" in still_missing


def test_duplicate_submission_reference_rejected():
    assert submit("T-COMPLETE-1", COMPLETE_PACKAGE).status_code == 409


def test_intake_is_driven_by_the_workflow_definition():
    body = submit("T-WORKFLOW-1", COMPLETE_PACKAGE).json()
    state = client.get("/workflows/runs/" + body["workflow_run_id"]).json()
    assert state["status"] == "completed"
    assert state["workflow"] == "case-intake-and-risk-scoring"
    assert state["context"]["completeness_check"]["is_complete"] is True
    assert client.get("/cases/T-WORKFLOW-1").json()["case_ready_timestamp"]


def test_case_opening_is_written_to_the_audit_trail():
    entries = [e for e in client.get("/api/audit_trail").json() if e["action_type"] == "case_opened"]
    assert entries and entries[0]["performed_by_role"] == "kyc_analyst"
    assert entries[0]["timestamp"]


def test_completeness_is_pure_and_reproducible():
    first = policy.completeness(COMPLETE_PACKAGE, SIMPLE_ATTRS, SIMPLE_FACTORS)
    second = policy.completeness(COMPLETE_PACKAGE, SIMPLE_ATTRS, SIMPLE_FACTORS)
    assert first == second and first["is_complete"] is True
