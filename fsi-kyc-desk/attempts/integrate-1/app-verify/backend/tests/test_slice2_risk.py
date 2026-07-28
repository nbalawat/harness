"""Slice 2 — deterministic risk scoring and banding."""
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


def test_risk_matrix_is_published_versioned_and_not_editable():
    body = client.get("/risk-matrix").json()
    assert body["version"]
    assert body["weights"]["jurisdiction"] == 0.3
    assert body["weights"]["sanctions_screening"] == 0.15
    assert body["editable"] is False
    bands = {b["band"]: b for b in body["bands"]}
    assert bands["low"]["max"] == 39
    assert bands["medium"]["max"] == 69
    assert bands["high"]["min"] == 70


def test_ad_hoc_score_is_pure_and_reproducible():
    factors = {
        "jurisdiction": "fatf_high_risk",
        "entity_structure": "nominee_shareholders",
        "industry": "cash_intensive_retail",
        "sanctions_screening": "clear",
        "expected_activity": "domestic_only",
    }
    first = client.post("/risk/score", json={"factors": factors}).json()
    second = client.post("/risk/score", json={"factors": factors}).json()
    assert first == second  # REQ-028: same inputs, same output every time
    assert first["total_risk_score"] == 55
    assert first["risk_band"] == "medium"
    assert "contribution" in client.post("/risk/score", json={"factors": factors}).text
    assert "weight" in client.post("/risk/score", json={"factors": factors}).text


def test_sanctions_true_positive_forces_high_band_regardless_of_total():
    body = client.post(
        "/risk/score",
        json={
            "factors": {
                "jurisdiction": "standard",
                "entity_structure": "nominee_shareholders",
                "industry": "money_services",
                "sanctions_screening": "true_positive",
                "expected_activity": "domestic_only",
            }
        },
    ).json()
    assert body["total_risk_score"] == 51
    assert body["risk_band"] == "high"
    assert body["sanctions_true_positive_override_applied"] is True


def test_case_scored_on_intake_reaches_the_expected_band_and_total():
    body = client.post("/cases", json=HIGH_PACKAGE).json()
    assert body["status"] == "ready"
    assert body["risk_band"] == "high"
    assert body["total_risk_score"] == 76
    assert body["risk_matrix_version"]


def test_score_breakdown_view_shows_input_raw_score_weight_and_contribution():
    body = client.get("/cases/ACC-HIGH-001/score-breakdown").json()
    assert body["total_risk_score"] == 76
    assert body["risk_band"] == "high"
    breakdown = {row["factor"]: row for row in body["factor_breakdown"]}
    assert breakdown["jurisdiction"]["raw_input"] == "fatf_high_risk"
    assert breakdown["jurisdiction"]["weight"] == 0.3
    assert "contribution" in breakdown["jurisdiction"]


def test_score_is_never_editable_by_any_role():
    response = client.post(
        "/cases/ACC-HIGH-001/score",
        json={"total_risk_score": 10, "risk_band": "Low", "acting_user": "cora.compliance"},
    )
    assert response.status_code == 403
    # the score on record is unchanged by the attempt
    assert client.get("/cases/ACC-HIGH-001/score-breakdown").json()["total_risk_score"] == 76
    trail = client.get("/api/audit_trail").json()
    assert any(e["action_type"] == "score_edit_refused" for e in trail)


def test_score_breakdown_404s_for_unknown_reference():
    assert client.get("/cases/NOPE-999/score-breakdown").status_code == 404


# --------------------------------------------------------------------------
# The slice plan's acceptance checks, replayed verbatim. The verifier asserts
# exactly these (status + substring containment on the raw response text), so
# a regression should fail here rather than costing a full boot cycle.
# --------------------------------------------------------------------------
ACCEPTANCE = [
    (
        "GET",
        "/risk-matrix",
        None,
        200,
        [
            "jurisdiction",
            "entity_structure",
            "industry",
            "sanctions_screening",
            "expected_activity",
            "0.3",
            "0.25",
            "0.15",
            "39",
            "69",
            "70",
            "version",
        ],
    ),
    (
        "POST",
        "/risk/score",
        {
            "factors": {
                "jurisdiction": "fatf_high_risk",
                "entity_structure": "nominee_shareholders",
                "industry": "cash_intensive_retail",
                "sanctions_screening": "clear",
                "expected_activity": "domestic_only",
            }
        },
        200,
        ["55", '"risk_band":"medium"', "contribution", "weight"],
    ),
    (
        "POST",
        "/risk/score",
        {
            "factors": {
                "jurisdiction": "fatf_high_risk",
                "entity_structure": "nominee_shareholders",
                "industry": "cash_intensive_retail",
                "sanctions_screening": "clear",
                "expected_activity": "domestic_only",
            }
        },
        200,
        ["55", '"risk_band":"medium"'],
    ),
    (
        "POST",
        "/risk/score",
        {
            "factors": {
                "jurisdiction": "standard",
                "entity_structure": "nominee_shareholders",
                "industry": "money_services",
                "sanctions_screening": "true_positive",
                "expected_activity": "domestic_only",
            }
        },
        200,
        ["51", '"risk_band":"high"', '"sanctions_true_positive_override_applied":true'],
    ),
    (
        "POST",
        "/cases",
        HIGH_PACKAGE,
        200,
        ['"status":"ready"', '"risk_band":"high"', "76", "risk_matrix_version"],
    ),
    (
        "GET",
        "/cases/ACC-HIGH-001/score-breakdown",
        None,
        200,
        ["jurisdiction", "fatf_high_risk", "weight", "contribution", "76", '"risk_band":"high"'],
    ),
    (
        "POST",
        "/cases/ACC-HIGH-001/score",
        {"total_risk_score": 10, "risk_band": "Low", "acting_user": "cora.compliance"},
        403,
        None,
    ),
]


def test_slice_plan_acceptance_checks_pass_in_order():
    """Run the plan's checks in sequence, exactly as the verifier does."""
    for method, path, body, expect_status, expect_contains in ACCEPTANCE:
        response = client.get(path) if method == "GET" else client.post(path, json=body)
        assert response.status_code == expect_status, f"{method} {path} -> {response.status_code}"
        # the verifier matches against the RAW response text — normalising here
        # would let this guard pass while the real verification fails
        text = response.text
        for needle in expect_contains or []:
            assert needle in text, f"{method} {path} missing {needle!r}"
