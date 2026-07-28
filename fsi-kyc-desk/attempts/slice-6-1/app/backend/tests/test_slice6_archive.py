"""Slice 6 — case search, audit trail view, CSV export and weekly report."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

# A dedicated, low-band unit fixture so the shared ACC-* references the slice
# plan's own acceptance replay depends on (below) stay exactly as earlier
# slices' test files left them — the same pattern every prior slice's test
# file follows (see e.g. test_slice5_sla.py's ACC-SLA-UNIT-001).
ARCHIVE_UNIT_PACKAGE = {
    "client_reference": "ACC-ARCHIVE-UNIT-001",
    "client_name": "Blackwood River Trading Ltd",
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
    existing = client.get("/cases/" + reference)
    if existing.status_code == 200:
        return existing.json()
    return client.post("/cases", json=package).json()


def test_search_cases_by_query_and_by_band():
    ensure_case("ACC-ARCHIVE-UNIT-001", ARCHIVE_UNIT_PACKAGE)

    by_query = client.get("/search/cases?q=Blackwood")
    assert by_query.status_code == 200
    body = by_query.json()
    assert body["count"] >= 1
    assert any(r["case_reference"] == "acc-archive-unit-001" for r in body["results"])

    by_band = client.get("/search/cases?risk_band=low")
    assert by_band.status_code == 200
    refs = [r["case_reference"] for r in by_band.json()["results"]]
    assert "acc-archive-unit-001" in refs
    for r in by_band.json()["results"]:
        assert r["risk_band"] == "low"

    no_match = client.get("/search/cases?q=no-such-client-anywhere")
    assert no_match.status_code == 200
    assert no_match.json()["count"] == 0


def test_export_case_file_csv_includes_audit_trail_only_when_asked():
    ensure_case("ACC-ARCHIVE-UNIT-001", ARCHIVE_UNIT_PACKAGE)

    without_trail = client.get("/export/cases/ACC-ARCHIVE-UNIT-001.csv")
    assert without_trail.status_code == 200
    assert without_trail.headers["content-type"].startswith("text/csv")
    assert "acc-archive-unit-001" in without_trail.text
    assert "checklist_item" in without_trail.text
    assert "audit_entry" not in without_trail.text

    with_trail = client.get("/export/cases/ACC-ARCHIVE-UNIT-001.csv?include=audit_trail")
    assert with_trail.status_code == 200
    assert "audit_entry" in with_trail.text
    assert "performed_by_role" in with_trail.text
    assert "old_value" in with_trail.text
    assert "new_value" in with_trail.text

    # The export itself is logged against the case's own trail.
    trail = client.get("/audit/cases/ACC-ARCHIVE-UNIT-001").json()["entries"]
    assert any(e["action_type"] == "case_file_exported" for e in trail)


def test_export_unknown_case_404s():
    response = client.get("/export/cases/no-such-case.csv")
    assert response.status_code == 404


def test_reproduction_unknown_case_404s():
    response = client.get("/cases/no-such-case/reproduction")
    assert response.status_code == 404


def test_reproduction_reads_the_cycle_that_was_asked_for():
    ensure_case("ACC-ARCHIVE-UNIT-001", ARCHIVE_UNIT_PACKAGE)
    response = client.get("/cases/ACC-ARCHIVE-UNIT-001/reproduction")
    assert response.status_code == 200
    body = response.json()
    assert body["case_reference"] == "acc-archive-unit-001"
    assert body["risk_matrix_version"] == "2.1"
    assert body["document_checklist_version"] == "2.0"
    assert body["risk_factors"]["jurisdiction"] == "standard"
    assert body["total_risk_score"] is not None


HIGH_BREACH_PACKAGE = {
    "client_reference": "ACC-ARCHIVE-BREACH-001",
    "client_name": "Falkirk Bullion Exchange",
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


def test_weekly_report_reads_the_breach_off_the_row_that_recorded_it():
    """A resubmission after a breach starts a fresh, UNBREACHED sla_tracking
    row for the new cycle, while the permanent cases.sla_breached flag
    (REQ-053) survives untouched. The report must still find the row that
    actually recorded the breach (not the newest cycle's row) so
    breached_at/period are never silently lost — a bug caught in review."""
    ensure_case("ACC-ARCHIVE-BREACH-001", HIGH_BREACH_PACKAGE)
    breach = client.post(
        "/sla/evaluate", json={"case_reference": "ACC-ARCHIVE-BREACH-001", "simulated_business_hours_elapsed": 9}
    ).json()["evaluated"][0]
    assert breach["breached"] is True

    report = client.get("/reports/weekly-operations").json()
    entry = next(c for c in report["breached_cases"] if c["case_reference"] == "acc-archive-breach-001")
    assert entry["breached_at"] is not None
    assert entry["period"] == report["period"]

    # Resubmit: same reference, new cycle, fresh unbreached SLA clock — but
    # sla_breached must remain permanently true.
    client.post("/cases", json=HIGH_BREACH_PACKAGE)
    case = client.get("/cases/ACC-ARCHIVE-BREACH-001").json()
    assert case["cycle"] == 2
    assert case["sla_breached"] is True

    report_after = client.get("/reports/weekly-operations").json()
    entry_after = next(c for c in report_after["breached_cases"] if c["case_reference"] == "acc-archive-breach-001")
    assert entry_after["breached_at"] is not None
    assert entry_after["period"] == report_after["period"]


def test_weekly_operations_report_shape():
    response = client.get("/reports/weekly-operations")
    assert response.status_code == 200
    body = response.json()
    assert "period" in body
    assert isinstance(body["breached_cases"], list)
    assert body["breached_count"] == len(body["breached_cases"])
    for case in body["breached_cases"]:
        assert case["breached"] is True


# --------------------------------------------------------------------------
# The slice plan's acceptance checks, replayed verbatim. By the time this
# module runs, ACC-COMPLETE-001 (rejected), ACC-HIGH-001 (approved, cycle 2)
# and ACC-SLA-001 (approved, permanently breached) already carry exactly the
# state earlier slices' test files leave them in — this file only reads them.
# --------------------------------------------------------------------------
def test_slice_plan_acceptance_checks_pass_in_order():
    response = client.get("/search/cases?q=Meridian")
    assert response.status_code == 200
    for needle in ["acc-complete-001", "meridian"]:
        assert needle in response.text

    response = client.get("/search/cases?risk_band=high")
    assert response.status_code == 200
    for needle in ["acc-high-001", '"risk_band":"high"']:
        assert needle in response.text

    response = client.get("/export/cases.csv")
    assert response.status_code == 200
    for needle in ["case_reference", "client_name", "risk_band", "status", "acc-high-001"]:
        assert needle in response.text

    response = client.get("/export/cases/ACC-HIGH-001.csv?include=audit_trail")
    assert response.status_code == 200
    for needle in ["acc-high-001", "machine-drafted", "performed_by_role", "old_value", "new_value"]:
        assert needle in response.text

    response = client.get("/audit/cases/ACC-COMPLETE-001?acting_user=aud.auditor")
    assert response.status_code == 200
    for needle in ["case_opened", "rejected", "performed_by_role", "timestamp"]:
        assert needle in response.text

    response = client.get("/cases/ACC-HIGH-001/reproduction")
    assert response.status_code == 200
    for needle in [
        "risk_matrix_version",
        "document_checklist_version",
        "onboarding_policy_version",
        "fatf_high_risk",
        "76",
        "memo_text",
        '"is_machine_drafted":true',
    ]:
        assert needle in response.text

    response = client.get("/reports/weekly-operations")
    assert response.status_code == 200
    for needle in ["acc-sla-001", "breached", "period"]:
        assert needle in response.text
