"""Slice 5 — SLA clocks, at-risk flags and the escalation chain."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

SLA_PACKAGE = {
    "client_reference": "ACC-SLA-001",
    "client_name": "Halcyon Global Payments",
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

# A dedicated high-band reference for this file's own unit tests, so the
# ACC-SLA-001 reference in the slice plan's own acceptance replay (below)
# stays pristine — the same pattern every earlier slice's test file follows.
SLA_UNIT_PACKAGE = dict(SLA_PACKAGE, client_reference="ACC-SLA-UNIT-001", client_name="Meridian Escrow Services")

# A low-band reference, whose 48-hour SLA a 7-hour simulated elapsed never
# threatens — used to prove the evaluator leaves a healthy clock alone.
LOW_UNIT_PACKAGE = {
    "client_reference": "ACC-SLA-LOW-UNIT-001",
    "client_name": "Fenwick Trading Co",
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


def ensure_case(reference, package):
    if client.get("/cases/" + reference).status_code != 200:
        client.post("/cases", json=package)


def test_sla_policy_endpoint_publishes_the_versioned_policy():
    response = client.get("/sla-policy")
    assert response.status_code == 200
    for needle in ["48", "24", "8", "80", "business_hours", "09:00", "17:00", "escalation_chain", "compliance_officer"]:
        assert needle in response.text


def test_workflow_definitions_still_validate():
    import workflow_engine

    assert workflow_engine.validate_definitions() == []


def test_evaluate_flags_at_risk_and_notifies_the_assigned_approver():
    ensure_case("ACC-SLA-UNIT-001", SLA_UNIT_PACKAGE)
    case = client.get("/cases/ACC-SLA-UNIT-001").json()
    assert case["risk_band"] == "high"
    assert case["sla_hours"] == 8
    assert case["is_at_risk"] is False

    response = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-UNIT-001", "simulated_business_hours_elapsed": 7}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    entry = body["evaluated"][0]
    assert entry["case_reference"] == "acc-sla-unit-001"
    assert entry["sla_state"] == "at_risk"
    assert entry["percent_consumed"] == 87.5
    assert entry["notification"]["recipient_user_id"] == "cora.compliance"
    assert entry["breach"] is None
    assert entry["escalation"] is None

    case = client.get("/cases/ACC-SLA-UNIT-001").json()
    assert case["is_at_risk"] is True
    assert case["status"] == "ready"
    assert case["sla_breached"] is False

    notifications = client.get("/notifications?case_reference=ACC-SLA-UNIT-001").json()["notifications"]
    assert any(n["notification_type"] == "at_risk" and n["recipient_user_id"] == "cora.compliance" for n in notifications)


def test_evaluate_breaches_permanently_and_escalates_up_the_chain():
    ensure_case("ACC-SLA-UNIT-001", SLA_UNIT_PACKAGE)

    breached = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-UNIT-001", "simulated_business_hours_elapsed": 9}
    ).json()
    entry = breached["evaluated"][0]
    assert entry["sla_state"] == "breached"
    assert entry["breach"]["breached"] is True
    assert entry["breach"]["permanent"] is True
    assert entry["escalation"]["escalation_level"] == 1
    assert entry["escalation"]["escalated_to_role"] == "compliance_officer"

    case = client.get("/cases/ACC-SLA-UNIT-001").json()
    assert case["sla_breached"] is True

    # A repeat poll at the SAME elapsed time re-confirms the breach (idempotent
    # audit_entry_id) but escalation still climbs one further level per poll —
    # that repetition is the intended "stays unactioned" signal, not a bug.
    repeat = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-UNIT-001", "simulated_business_hours_elapsed": 9}
    ).json()["evaluated"][0]
    assert repeat["breach"]["audit_entry_id"] == entry["breach"]["audit_entry_id"]
    assert repeat["escalation"]["escalation_level"] == 2

    escalated_further = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-UNIT-001", "simulated_business_hours_elapsed": 14}
    ).json()
    entry2 = escalated_further["evaluated"][0]
    assert entry2["escalation"]["escalation_level"] == 3
    assert entry2["escalation"]["escalated_to_role"] == "coo"
    assert entry2["escalation"]["escalated_to_user_id"] == "kim.coo"

    # The chain is only 3 steps long — a further poll caps at the last step
    # rather than indexing past it.
    capped = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-UNIT-001", "simulated_business_hours_elapsed": 20}
    ).json()["evaluated"][0]
    assert capped["escalation"]["escalation_level"] == 3
    assert capped["escalation"]["escalated_to_role"] == "coo"

    escalations = client.get("/escalations?case_reference=ACC-SLA-UNIT-001").json()["escalations"]
    assert [e["escalation_level"] for e in escalations] == [1, 2, 3, 3]

    # A decision after the window closes still records — clock pressure never
    # unlocks a shortcut, and it never rewrites the permanent breach.
    decided = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-SLA-UNIT-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "Decision taken after the SLA window closed; screening hit resolved as false positive.",
        },
    )
    assert decided.status_code == 200
    case = client.get("/cases/ACC-SLA-UNIT-001").json()
    assert case["status"] == "approved"
    assert case["sla_breached"] is True


def test_evaluate_leaves_a_healthy_clock_and_a_decided_case_alone():
    ensure_case("ACC-SLA-LOW-UNIT-001", LOW_UNIT_PACKAGE)
    case = client.get("/cases/ACC-SLA-LOW-UNIT-001").json()
    assert case["risk_band"] == "low"
    assert case["sla_hours"] == 48

    response = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-SLA-LOW-UNIT-001", "simulated_business_hours_elapsed": 7}
    ).json()
    entry = response["evaluated"][0]
    assert entry["sla_state"] == "ok"
    assert entry["notification"] is None
    case = client.get("/cases/ACC-SLA-LOW-UNIT-001").json()
    assert case["is_at_risk"] is False
    assert case["sla_breached"] is False

    # Decide it, then prove the bulk (no case_reference) evaluator skips it —
    # SLICES.md's slice-1 note (g): the evaluator must never re-touch a
    # decided cycle.
    client.post(
        "/decisions",
        json={
            "case_reference": "ACC-SLA-LOW-UNIT-001",
            "decision": "approve",
            "acting_user": "ana.analyst",
            "rationale": "Simple domestic structure, low band.",
        },
    )
    bulk = client.post("/sla/evaluate", json={"simulated_business_hours_elapsed": 100}).json()
    refs = [e["case_reference"] for e in bulk["evaluated"]]
    assert "acc-sla-low-unit-001" not in refs


def test_evaluate_unknown_case_reference_404s():
    response = client.post("/sla/evaluate", json={"case_reference": "no-such-case", "simulated_business_hours_elapsed": 1})
    assert response.status_code == 404


# --------------------------------------------------------------------------
# The slice plan's acceptance checks, replayed verbatim. The verifier asserts
# exactly these (status + substring containment on the raw response text), so
# a regression should fail here rather than costing a full boot cycle.
# --------------------------------------------------------------------------
def test_slice_plan_acceptance_checks_pass_in_order():
    response = client.get("/sla-policy")
    assert response.status_code == 200
    for needle in ["48", "24", "8", "80", "business_hours", "09:00", "17:00"]:
        assert needle in response.text

    response = client.post("/cases", json=SLA_PACKAGE)
    assert response.status_code == 200
    for needle in ['"status":"ready"', '"risk_band":"high"', "sla_due_timestamp", "assigned_approver_id"]:
        assert needle in response.text

    response = client.post("/sla/evaluate", json={"simulated_business_hours_elapsed": 7})
    assert response.status_code == 200
    for needle in ["acc-sla-001", '"sla_state":"at_risk"', "notification"]:
        assert needle in response.text

    response = client.get("/cases/ACC-SLA-001")
    assert response.status_code == 200
    for needle in ['"is_at_risk":true', '"status":"ready"']:
        assert needle in response.text

    response = client.get("/notifications")
    assert response.status_code == 200
    for needle in ["at_risk", "recipient_user_id", "sent_at", "cora.compliance"]:
        assert needle in response.text

    response = client.post("/sla/evaluate", json={"simulated_business_hours_elapsed": 9})
    assert response.status_code == 200
    for needle in ["acc-sla-001", '"breached":true', "escalation"]:
        assert needle in response.text

    response = client.get("/escalations")
    assert response.status_code == 200
    for needle in ["acc-sla-001", '"escalation_level":1', "compliance_officer", "escalated_at"]:
        assert needle in response.text

    response = client.post("/sla/evaluate", json={"simulated_business_hours_elapsed": 14})
    assert response.status_code == 200
    for needle in ["acc-sla-001", "head_of_financial_crime"]:
        assert needle in response.text

    response = client.get("/cases")
    assert response.status_code == 200
    for needle in ["risk_band", "assigned_approver_id", "sla_due_timestamp", "is_at_risk", '"sla_breached":true']:
        assert needle in response.text

    response = client.post(
        "/decisions",
        json={
            "case_reference": "ACC-SLA-001",
            "decision": "approve",
            "acting_user": "cora.compliance",
            "rationale": "Decision taken after the SLA window closed; enhanced due diligence complete and screening hit cleared.",
        },
    )
    assert response.status_code == 200
    for needle in ['"status":"approved"', '"decided_by_role":"compliance_officer"']:
        assert needle in response.text

    response = client.get("/cases/ACC-SLA-001")
    assert response.status_code == 200
    for needle in ['"status":"approved"', '"sla_breached":true']:
        assert needle in response.text
