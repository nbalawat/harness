"""Slice 1 — case intake and the deterministic document completeness check."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

COMPLETE_PACKAGE = {
    "client_reference": "T-COMPLETE-001",
    "client_name": "Northwind Freight Ltd",
    "entity_type": "corporate",
    "submitted_by": "ana.analyst",
    "documents": [
        "certificate_of_incorporation",
        "register_of_directors",
        "beneficial_ownership_declaration",
        "proof_of_registered_address",
    ],
    "attributes": {"ownership_chain_depth": 1, "regulated_industry": False, "cross_border_expected": False},
    "risk_factors": {
        "jurisdiction": "standard",
        "entity_structure": "simple",
        "industry": "other",
        "sanctions_screening": "clear",
        "expected_activity": "domestic_only",
    },
}

INCOMPLETE_PACKAGE = {
    "client_reference": "T-RETURNED-001",
    "client_name": "Pelican Nominees SA",
    "entity_type": "corporate",
    "submitted_by": "ana.analyst",
    "documents": ["certificate_of_incorporation", "proof_of_registered_address"],
    "attributes": {"ownership_chain_depth": 4, "regulated_industry": True, "cross_border_expected": True},
    "risk_factors": {
        "jurisdiction": "fatf_high_risk",
        "entity_structure": "chain_depth_over_3",
        "industry": "money_services",
        "sanctions_screening": "clear",
        "expected_activity": "cross_border_over_1m",
    },
}


def test_checklist_is_published_and_versioned():
    body = client.get("/checklist").json()
    assert body["version"]
    types = body["all_document_types"]
    for doc in (
        "certificate_of_incorporation",
        "register_of_directors",
        "beneficial_ownership_declaration",
        "proof_of_registered_address",
        "structure_chart",
        "operating_license",
        "expected_activity_questionnaire",
    ):
        assert doc in types
    assert body["waivable"] is False


def test_complete_package_moves_case_to_ready():
    body = client.post("/cases", json=COMPLETE_PACKAGE).json()
    assert body["case_reference"] == "t-complete-001"
    assert body["status"] == "ready"
    assert body["case_ready_timestamp"]
    assert body["completeness_passed_at"]
    assert body["missing_documents"] == []
    assert body["document_checklist_version"]
    assert body["workflow_status"] == "completed"


def test_incomplete_package_is_returned_with_itemised_missing_list():
    body = client.post("/cases", json=INCOMPLETE_PACKAGE).json()
    assert body["status"] == "returned"
    assert body["case_ready_timestamp"] is None
    missing = body["missing_documents"]
    for doc in (
        "register_of_directors",
        "beneficial_ownership_declaration",
        "structure_chart",
        "operating_license",
        "expected_activity_questionnaire",
    ):
        assert doc in missing


def test_conditional_items_only_apply_when_triggered():
    payload = dict(COMPLETE_PACKAGE, client_reference="T-COND-001")
    body = client.post("/cases", json=payload).json()
    assert body["status"] == "ready"
    conditional = [c for c in body["checklist"] if c["conditionally_required"]]
    assert conditional and all(c["required"] is False for c in conditional)


def test_worklist_and_case_detail_are_addressable_by_reference():
    listing = client.get("/cases").json()
    refs = [c["case_reference"] for c in listing["cases"]]
    assert "t-complete-001" in refs and "t-returned-001" in refs

    detail = client.get("/cases/T-RETURNED-001")  # references are case-insensitive
    assert detail.status_code == 200
    assert detail.json()["status"] == "returned"
    assert "register_of_directors" in detail.json()["missing_documents"]


def test_unknown_case_reference_404s():
    assert client.get("/cases/NOPE-999").status_code == 404


def test_no_role_can_waive_a_required_document():
    response = client.post(
        "/cases/T-RETURNED-001/waive-document",
        json={"document_type": "register_of_directors", "acting_user": "ana.analyst"},
    )
    assert response.status_code == 403
    assert "compliance" in response.json()["detail"].lower()
    # the refusal itself is on the record, and the item is still missing
    assert "register_of_directors" in client.get("/cases/T-RETURNED-001").json()["missing_documents"]


def test_intake_runs_the_approved_workflow_and_writes_the_audit_trail():
    assert workflow_problems() == []
    trail = [e for e in client.get("/api/audit_trail").json()]
    actions = {e["action_type"] for e in trail}
    assert "case_opened" in actions
    assert "completeness_checked" in actions
    assert "case_returned" in actions
    assert all("performed_by_role" in e and "timestamp" in e for e in trail)


def workflow_problems():
    import workflow_engine

    return workflow_engine.validate_definitions()
