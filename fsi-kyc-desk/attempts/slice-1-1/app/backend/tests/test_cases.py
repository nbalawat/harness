"""case-intake-completeness slice tests — mirrors the slice's acceptance script."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_complete_case_goes_ready():
    body = {
        "client_reference": "ACC-COMPLETE-001",
        "client_name": "Meridian Holdings Ltd",
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
    resp = client.post("/cases", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["case_reference"] == "acc-complete-001"
    assert data["status"] == "ready"
    assert data["case_ready_timestamp"]
    assert data["document_checklist_version"]
    assert data["missing_documents"] == []


def test_incomplete_case_is_returned_with_itemised_missing_list():
    body = {
        "client_reference": "ACC-RETURNED-001",
        "client_name": "Kestrel Nominees SA",
        "entity_type": "corporate",
        "submitted_by": "ana.analyst",
        "documents": ["certificate_of_incorporation", "proof_of_registered_address"],
        "attributes": {"ownership_chain_depth": 3, "regulated_industry": True, "cross_border_expected": False},
        "risk_factors": {
            "jurisdiction": "fatf_high_risk",
            "entity_structure": "chain_depth_over_3",
            "industry": "money_services",
            "sanctions_screening": "clear",
            "expected_activity": "domestic_only",
        },
    }
    resp = client.post("/cases", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "returned"
    assert set(data["missing_documents"]) == {
        "register_of_directors",
        "beneficial_ownership_declaration",
        "structure_chart",
        "operating_license",
    }


def test_cross_border_without_questionnaire_is_returned():
    body = {
        "client_reference": "ACC-RETURNED-002",
        "client_name": "Solano Trading Corp",
        "entity_type": "corporate",
        "submitted_by": "ana.analyst",
        "documents": [
            "certificate_of_incorporation",
            "register_of_directors",
            "beneficial_ownership_declaration",
            "proof_of_registered_address",
        ],
        "attributes": {"ownership_chain_depth": 1, "regulated_industry": False, "cross_border_expected": True},
        "risk_factors": {
            "jurisdiction": "standard",
            "entity_structure": "simple",
            "industry": "other",
            "sanctions_screening": "clear",
            "expected_activity": "cross_border_over_1m",
        },
    }
    resp = client.post("/cases", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "returned"
    assert "expected_activity_questionnaire" in data["missing_documents"]


def test_worklist_and_case_detail():
    resp = client.get("/cases")
    assert resp.status_code == 200
    refs = {row["case_reference"] for row in resp.json()}
    assert "acc-complete-001" in refs
    assert "acc-returned-001" in refs

    resp = client.get("/cases/ACC-RETURNED-001")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "returned"
    assert "register_of_directors" in data["missing_documents"]


def test_no_analyst_can_waive_a_required_document():
    resp = client.post(
        "/cases/ACC-RETURNED-001/waive-document",
        json={"document_type": "register_of_directors", "acting_user": "ana.analyst"},
    )
    assert resp.status_code == 403
    assert "compliance" in resp.text.lower()


def test_checklist_endpoint():
    resp = client.get("/checklist")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"]
    doc_types = {item["document_type"] for item in data["items"]}
    assert {
        "certificate_of_incorporation",
        "register_of_directors",
        "beneficial_ownership_declaration",
        "proof_of_registered_address",
        "structure_chart",
        "operating_license",
        "expected_activity_questionnaire",
    } <= doc_types


def test_unknown_case_404():
    assert client.get("/cases/NOT-A-CASE").status_code == 404
