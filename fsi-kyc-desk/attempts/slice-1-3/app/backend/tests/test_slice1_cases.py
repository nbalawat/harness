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


def ensure_cases():
    """Each test stands on its own — re-submitting a reference supersedes it."""
    client.post("/cases", json=COMPLETE_PACKAGE)
    client.post("/cases", json=INCOMPLETE_PACKAGE)


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


def test_resubmission_opens_a_new_cycle_on_the_same_case():
    ensure_cases()
    first = client.get("/cases/T-RETURNED-001").json()
    again = client.post("/cases", json=INCOMPLETE_PACKAGE).json()
    assert again["case_id"] == first["case_id"]  # one reference, one case id
    assert again["cycle"] == first["cycle"] + 1
    assert again["status"] == "returned"
    refs = [c["case_reference"] for c in client.get("/cases").json()["cases"]]
    assert refs.count("t-returned-001") == 1
    # the earlier cycle's checklist rows are retained but do not double-count
    assert len(again["missing_documents"]) == len(set(again["missing_documents"]))


def test_a_new_cycle_carries_no_stale_score_or_sla_clock():
    """A cycle that is RETURNED must not advertise the previous cycle's band."""
    ref = "T-CYCLE-STALE-001"
    ready = client.post("/cases", json=dict(COMPLETE_PACKAGE, client_reference=ref)).json()
    assert ready["status"] == "ready" and ready["risk_band"] and ready["sla_due_timestamp"]

    short = client.post(
        "/cases",
        json=dict(COMPLETE_PACKAGE, client_reference=ref, documents=["certificate_of_incorporation"]),
    ).json()
    assert short["status"] == "returned"
    assert short["risk_band"] is None and short["total_risk_score"] is None
    assert short["sla_due_timestamp"] is None and short["assigned_approver_id"] is None
    assert short["is_at_risk"] is False


def test_each_cycle_keeps_the_policy_versions_and_outcome_that_applied_to_it():
    ref = "T-CYCLE-SNAP-001"
    client.post("/cases", json=dict(COMPLETE_PACKAGE, client_reference=ref, documents=[]))
    client.post("/cases", json=dict(COMPLETE_PACKAGE, client_reference=ref))
    cycles = client.get("/cases/" + ref).json()["cycles"]
    assert [c["cycle"] for c in cycles] == [1, 2]
    assert cycles[0]["status"] == "returned" and cycles[0]["missing_documents"]
    assert cycles[1]["status"] == "ready" and cycles[1]["missing_documents"] == []
    assert cycles[1]["total_risk_score"] is not None
    for snapshot in cycles:  # REQ-070: versions travel with the cycle
        assert snapshot["document_checklist_version"] and snapshot["risk_matrix_version"]
        assert snapshot["onboarding_policy_version"]


def test_regulated_industries_require_a_licence_without_the_attribute():
    payload = dict(
        COMPLETE_PACKAGE,
        client_reference="T-GAMBLING-001",
        attributes={"ownership_chain_depth": 1, "cross_border_expected": False},
        risk_factors=dict(COMPLETE_PACKAGE["risk_factors"], industry="gambling"),
    )
    body = client.post("/cases", json=payload).json()
    assert body["status"] == "returned"
    assert "operating_license" in body["missing_documents"]


def test_risk_matrix_scores_match_the_published_matrix():
    import kyc_policy

    scored = kyc_policy.score_factors(
        {
            "jurisdiction": "fatf_high_risk",
            "entity_structure": "nominee_shareholders",
            "industry": "cash_intensive_retail",
            "sanctions_screening": "clear",
            "expected_activity": "domestic_only",
        }
    )
    # 90*.30 + 60*.25 + 55*.20 + 0*.15 + 20*.10 — Risk Rating Matrix v2.1
    assert scored["total_risk_score"] == 55
    assert scored["risk_band"] == "medium"
    assert scored["sanctions_true_positive_override_applied"] is False

    override = kyc_policy.score_factors(
        {
            "jurisdiction": "standard",
            "entity_structure": "nominee_shareholders",
            "industry": "money_services",
            "sanctions_screening": "true_positive",
            "expected_activity": "domestic_only",
        }
    )
    assert override["total_risk_score"] == 51
    assert override["risk_band"] == "high"  # forced regardless of the total
    assert override["sanctions_true_positive_override_applied"] is True


def test_structure_chart_is_required_beyond_one_ownership_layer():
    payload = dict(
        COMPLETE_PACKAGE,
        client_reference="T-DEPTH-002",
        attributes={"ownership_chain_depth": 2, "regulated_industry": False, "cross_border_expected": False},
    )
    body = client.post("/cases", json=payload).json()
    assert body["status"] == "returned"
    assert "structure_chart" in body["missing_documents"]


def test_worklist_and_case_detail_are_addressable_by_reference():
    ensure_cases()
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
    ensure_cases()
    response = client.post(
        "/cases/T-RETURNED-001/waive-document",
        json={"document_type": "register_of_directors", "acting_user": "ana.analyst"},
    )
    assert response.status_code == 403
    assert "compliance" in response.json()["detail"].lower()
    # the refusal itself is on the record, and the item is still missing
    assert "register_of_directors" in client.get("/cases/T-RETURNED-001").json()["missing_documents"]


def test_intake_runs_the_approved_workflow_and_writes_the_audit_trail():
    ensure_cases()
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
