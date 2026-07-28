"""Slice 4 — role-based access and tiered human approval."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

HIGH_PACKAGE = {
    "client_reference": "ACC-HIGH-001",
    "client_name": "Aurelia Payments Group",
    "entity_type": "corporate",
    "submitted_by": "ana.analyst",
    "documents": [
        "certificate_of_incorporation",
        "register_of_directors",
        "beneficial_ownership_declaration",
        "proof_of_registered_address",
        "structure_chart",
        "operating_license",
        "expected_activity_questionnaire",
    ],
    "attributes": {"ownership_chain_depth": 2, "regulated_industry": True, "cross_border_expected": True},
    "risk_factors": {
        "jurisdiction": "fatf_high_risk",
        "entity_structure": "nominee_shareholders",
        "industry": "money_services",
        "sanctions_screening": "unresolved_possible",
        "expected_activity": "cross_border_over_1m",
    },
}

COMPLETE_PACKAGE = {
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

RETURNED_PACKAGE = {
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

# Dedicated, exploratory-only references so these tests never disturb the
# idempotency (one decision per cycle) or exception state the slice plan's
# own acceptance replay relies on for ACC-HIGH-001 / ACC-COMPLETE-001 /
# ACC-RETURNED-001 below.
LOW_UNIT_PACKAGE = dict(COMPLETE_PACKAGE, client_reference="ACC-DECISION-LOW-001", client_name="Fenwick Trading Co")
MEDIUM_UNIT_PACKAGE = {
    "client_reference": "ACC-DECISION-MEDIUM-001",
    "client_name": "Osprey Commodities Ltd",
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
        "jurisdiction": "enhanced_monitoring",
        "entity_structure": "nominee_shareholders",
        "industry": "cash_intensive_retail",
        "sanctions_screening": "clear",
        "expected_activity": "domestic_only",
    },
}
HIGH_UNIT_PACKAGE = dict(HIGH_PACKAGE, client_reference="ACC-DECISION-UNIT-001", client_name="Solstice Capital Partners")
EXCEPTION_UNIT_PACKAGE = dict(RETURNED_PACKAGE, client_reference="ACC-EXCEPTION-UNIT-001", client_name="Talbot Reinsurance SA")


def ensure_case(reference, package):
    if client.get("/cases/" + reference).status_code != 200:
        client.post("/cases", json=package)


def ensure_high_case():
    ensure_case("ACC-HIGH-001", HIGH_PACKAGE)


def ensure_complete_case():
    ensure_case("ACC-COMPLETE-001", COMPLETE_PACKAGE)


def ensure_returned_case():
    ensure_case("ACC-RETURNED-001", RETURNED_PACKAGE)


def test_roles_endpoint_lists_every_tier_with_its_band_range():
    body = client.get("/roles").json()
    roles = {r["role"] for r in body["roles"]}
    assert {"kyc_analyst", "senior_analyst", "compliance_officer", "auditor"} <= roles
    auditor = next(r for r in body["roles"] if r["role"] == "auditor")
    assert auditor["may_decide"] is False
    bands = {b["band"]: b for b in body["bands"]}
    assert bands["medium"]["min"] == 40
    assert bands["high"]["min"] == 70


def test_users_endpoint_lists_named_individual_accounts():
    body = client.get("/users").json()
    usernames = {u["username"] for u in body["users"]}
    assert {"ana.analyst", "sam.senior", "cora.compliance", "aud.auditor"} <= usernames
    ana = next(u for u in body["users"] if u["username"] == "ana.analyst")
    assert ana["role"] == "kyc_analyst"


def test_low_band_is_decided_by_kyc_analyst():
    ensure_case("ACC-DECISION-LOW-001", LOW_UNIT_PACKAGE)
    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-LOW-001",
            "decision": "approve",
            "acting_user": "ana.analyst",
            "rationale": "Simple domestic structure, low band, approved at analyst level.",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "approved"
    assert body["decided_by_role"] == "kyc_analyst"
    assert body["required_role_tier"] == "kyc_analyst"


def test_medium_band_requires_senior_analyst_not_kyc_analyst():
    ensure_case("ACC-DECISION-MEDIUM-001", MEDIUM_UNIT_PACKAGE)
    case = client.get("/cases/ACC-DECISION-MEDIUM-001").json()
    assert case["risk_band"] == "medium"
    refused = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-MEDIUM-001",
            "decision": "approve",
            "acting_user": "ana.analyst",
            "rationale": "Attempting to approve above my tier.",
        },
    )
    assert refused.status_code == 403
    assert "senior_analyst" in refused.json()["detail"]
    approved = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-MEDIUM-001",
            "decision": "approve",
            "acting_user": "sam.senior",
            "rationale": "Reviewed at Senior Analyst level for the Medium band.",
        },
    )
    assert approved.status_code == 200
    assert approved.json()["decided_by_role"] == "senior_analyst"


def test_auditor_and_unroled_actors_can_never_decide():
    ensure_case("ACC-DECISION-UNIT-001", HIGH_UNIT_PACKAGE)
    for actor in ("aud.auditor", "sla-evaluator-job"):
        response = client.post(
            "/decisions",
            json={
                "case_reference": "ACC-DECISION-UNIT-001",
                "decision": "approve",
                "acting_user": actor,
                "rationale": "Attempting a decision.",
            },
        )
        assert response.status_code == 403, actor


def test_high_band_approve_requires_a_documented_rationale():
    ensure_case("ACC-DECISION-UNIT-001", HIGH_UNIT_PACKAGE)
    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-UNIT-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "",
        },
    )
    assert response.status_code == 400
    assert "rationale" in response.json()["detail"]


def test_high_band_approved_by_compliance_officer_records_full_decision():
    ensure_case("ACC-DECISION-UNIT-001", HIGH_UNIT_PACKAGE)
    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-UNIT-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "Enhanced due diligence complete; ownership verified to natural persons.",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "approved"
    assert body["decided_by_role"] == "compliance_officer"
    assert body["required_role_tier"] == "compliance_officer"
    assert body["decided_at"]
    assert body["memo_version_id"]  # a memo is auto-drafted so there is always one to adopt
    assert body["next_review_due_date"]
    case = client.get("/cases/ACC-DECISION-UNIT-001").json()
    assert case["status"] == "approved"
    # a second decision on the same cycle is a conflict, never a silent overwrite
    again = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-DECISION-UNIT-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "Second attempt.",
        },
    )
    assert again.status_code == 409


def test_decision_leaves_no_parked_workflow_run_dangling():
    """A decided case must not still look like an unactioned approval to the
    generic workflow endpoints — /decisions auto-drafts a memo (parking a
    workflow run at risk-memo-and-approval's human node) and must resolve
    it, not just leave it stuck 'parked' forever."""
    import workflow_engine
    from db import store as _store

    reference = "ACC-DECISION-CLEANUP-001"
    ensure_case(reference, dict(LOW_UNIT_PACKAGE, client_reference=reference, client_name="Corvid Freight Ltd"))
    response = client.post(
        "/decisions",
        json={
            "case_reference": reference,
            "decision": "approve",
            "acting_user": "ana.analyst",
            "rationale": "Straightforward low-band file.",
        },
    )
    assert response.status_code == 200
    case_id = client.get("/cases/" + reference).json()["case_id"]

    run_ids = {
        e["run_id"]
        for e in _store.list("_wf_events")
        if e.get("type") == "run.started" and e.get("workflow") == "risk-memo-and-approval"
    }
    matching_runs = [
        run_id
        for run_id in run_ids
        if (workflow_engine.state(run_id).get("context") or {}).get("load_case", {}).get("case_id") == case_id
    ]
    assert matching_runs, "expected the auto-draft to have started at least one workflow run for this case"
    for run_id in matching_runs:
        assert workflow_engine.state(run_id).get("status") != "parked", f"run {run_id} left parked after a decision"


def test_reject_requires_a_reason_and_notifies_the_relationship_team():
    reference = "ACC-DECISION-REJECT-001"
    ensure_case(reference, dict(LOW_UNIT_PACKAGE, client_reference=reference, client_name="Harrow Import Partners"))
    refused = client.post(
        "/decisions", json={"case_reference": reference, "decision": "reject", "acting_user": "ana.analyst"}
    )
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]
    accepted = client.post(
        "/decisions",
        json={
            "case_reference": reference,
            "decision": "reject",
            "acting_user": "ana.analyst",
            "reason": "Documents inconsistent with the register of directors.",
        },
    )
    assert accepted.status_code == 200
    body = accepted.json()
    assert body["status"] == "rejected"
    assert body["decided_by_role"] == "kyc_analyst"
    notifications = client.get("/notifications", params={"case_reference": reference}).json()["notifications"]
    assert notifications
    assert any(n["notification_type"] == "case_rejected" for n in notifications)
    assert any("relationship" in n["message"].lower() for n in notifications)


def test_login_refuses_a_named_roster_account_without_its_passcode():
    """A named roster account (whose role gates real decisions) cannot be
    logged into by guessing the username alone — see SLICES.md slice 1 note
    (vi) and the slice 4 entry for why this closes a real bypass."""
    refused = client.post("/auth/login", json={"username": "cora.compliance", "password": "not-the-passcode"})
    assert refused.status_code == 401
    refused_blank = client.post("/auth/login", json={"username": "cora.compliance"})
    assert refused_blank.status_code == 401
    accepted = client.post("/auth/login", json={"username": "cora.compliance", "password": "cora-7734"})
    assert accepted.status_code == 200
    assert accepted.json()["username"] == "cora.compliance"


def test_login_still_allows_a_non_roster_username_with_no_tier_to_protect():
    response = client.post("/auth/login", json={"username": "anyone-off-roster"})
    assert response.status_code == 200


def test_only_compliance_officer_may_grant_a_policy_exception():
    ensure_case("ACC-EXCEPTION-UNIT-001", EXCEPTION_UNIT_PACKAGE)
    refused = client.post(
        "/cases/ACC-EXCEPTION-UNIT-001/exceptions",
        json={
            "acting_user": "ana.analyst",
            "document_type": "register_of_directors",
            "reason": "Client says it is unavailable.",
        },
    )
    assert refused.status_code == 403
    granted = client.post(
        "/cases/ACC-EXCEPTION-UNIT-001/exceptions",
        json={
            "acting_user": "cora.compliance",
            "document_type": "register_of_directors",
            "reason": "Register filed with the local regulator; certified copy requested and pending.",
        },
    )
    assert granted.status_code == 200
    body = granted.json()
    assert body["granted_by_user_id"] == "cora.compliance"
    assert body["document_type"] == "register_of_directors"


def test_audit_trail_has_no_delete_operation():
    assert client.post("/audit/entries/1/delete").status_code == 404
    assert client.post("/audit/entries/999999/delete").status_code == 404


def test_workflow_definitions_still_validate():
    import workflow_engine

    assert workflow_engine.validate_definitions() == []


# --------------------------------------------------------------------------
# The slice plan's acceptance checks, replayed verbatim. The verifier asserts
# exactly these (status + substring containment on the raw response text), so
# a regression should fail here rather than costing a full boot cycle.
# --------------------------------------------------------------------------
def test_slice_plan_acceptance_checks_pass_in_order():
    ensure_high_case()
    ensure_complete_case()
    ensure_returned_case()

    response = client.get("/roles")
    assert response.status_code == 200
    for needle in ["kyc_analyst", "senior_analyst", "compliance_officer", "auditor", "40", "70"]:
        assert needle in response.text

    response = client.get("/users")
    assert response.status_code == 200
    for needle in ["ana.analyst", "sam.senior", "cora.compliance", "aud.auditor", "kyc_analyst"]:
        assert needle in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-HIGH-001",
            "decision": "approve",
            "acting_user": "ana.analyst",
            "rationale": "Looks acceptable to me.",
        },
    )
    assert response.status_code == 403
    assert "compliance_officer" in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-HIGH-001",
            "decision": "approve",
            "acting_user": "aud.auditor",
            "rationale": "Auditor attempting a decision.",
        },
    )
    assert response.status_code == 403

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-HIGH-001",
            "decision": "approve",
            "acting_user": "sla-evaluator-job",
            "rationale": "Auto-approved to meet SLA.",
        },
    )
    assert response.status_code == 403

    response = client.post(
        "/decisions",
        json={"case_reference": "ACC-HIGH-001", "decision": "approve", "acting_user": "cora.compliance", "rationale": ""},
    )
    assert response.status_code == 400
    assert "rationale" in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-HIGH-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": (
                "Enhanced due diligence complete; beneficial owners verified to natural persons and possible "
                "sanctions hit resolved as false positive."
            ),
        },
    )
    assert response.status_code == 200
    for needle in [
        '"status":"approved"',
        '"decided_by_role":"compliance_officer"',
        '"required_role_tier":"compliance_officer"',
        "decided_at",
        "memo_version_id",
        "next_review_due_date",
    ]:
        assert needle in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-HIGH-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "Second attempt at the same decision.",
        },
    )
    assert response.status_code == 409

    response = client.post(
        "/decisions", json={"case_reference": "ACC-COMPLETE-001", "decision": "reject", "acting_user": "ana.analyst"}
    )
    assert response.status_code == 400
    assert "reason" in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-COMPLETE-001",
            "decision": "reject",
            "acting_user": "ana.analyst",
            "reason": "Beneficial ownership declaration is inconsistent with the register of directors.",
        },
    )
    assert response.status_code == 200
    for needle in ['"status":"rejected"', '"decided_by_role":"kyc_analyst"', "decided_at"]:
        assert needle in response.text

    response = client.get("/notifications", params={"case_reference": "ACC-COMPLETE-001"})
    assert response.status_code == 200
    for needle in ["recipient_user_id", "rejected", "relationship"]:
        assert needle in response.text

    response = client.post(
        "/cases/ACC-RETURNED-001/exceptions",
        json={
            "acting_user": "ana.analyst",
            "document_type": "register_of_directors",
            "reason": "Client says the register is unavailable.",
        },
    )
    assert response.status_code == 403

    response = client.post(
        "/cases/ACC-RETURNED-001/exceptions",
        json={
            "acting_user": "cora.compliance",
            "document_type": "register_of_directors",
            "reason": "Register filed with the local regulator; certified copy requested and pending.",
        },
    )
    assert response.status_code == 200
    for needle in ["granted_by_user_id", "cora.compliance", "register_of_directors"]:
        assert needle in response.text

    response = client.get("/audit/cases/ACC-HIGH-001")
    assert response.status_code == 200
    for needle in ["performed_by_role", "old_value", "new_value", "timestamp", "approved"]:
        assert needle in response.text

    response = client.post("/audit/entries/1/delete")
    assert response.status_code == 404
