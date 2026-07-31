"""Slice 1 — FSI hardening behaviours added on review.

Same style as the rest of the suite: stub agent mode pinned, TestClient over
the composed app. Each test pins one convention that a reviewer flagged as
bypassable, so a later slice cannot quietly regress it.
"""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import blob_store  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import underwriting as uw  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

BASE = {
    "borrower_industry": "surgical instrument manufacturing",
    "borrower_state": "North Carolina",
    "facility_type": "term_loan",
    "requested_amount": 400000,
    "collateral_value": 700000,
    "purpose": "equipment",
    "submitted_by": "rm.rivera",
    "documents": [],
}


def _submit(reference, **overrides):
    body = dict(BASE, deal_reference=reference, borrower_name="Hardening Test Co")
    body.update(overrides)
    return client.post("/deals", json=body)


# ------------------------------------------------------------------ CSV export


def test_board_export_neutralises_spreadsheet_formulas():
    """A borrower name is attacker-supplied and lands in an examiner's
    spreadsheet — it must never arrive as a live formula (hardening rule 1)."""
    _submit("T-HARD-CSV", borrower_name='=HYPERLINK("http://evil.example","clickme")')
    text = client.get("/deals/export.csv").text
    assert "T-HARD-CSV" in text
    assert '"\'=HYPERLINK' in text or "'=HYPERLINK" in text
    for line in text.splitlines()[1:]:
        for cell in line.split(","):
            assert not cell.lstrip('"').startswith(("=", "+", "@", "\t", "\r"))


def test_csv_cell_helper_leaves_ordinary_values_alone():
    from ext_deals import _csv_cell

    assert _csv_cell("Piedmont Orthopedic Devices LLC") == "Piedmont Orthopedic Devices LLC"
    assert _csv_cell(780000.0) == 780000.0
    assert _csv_cell(None) is None
    assert _csv_cell("=1+1") == "'=1+1"
    assert _csv_cell("@SUM(A1)") == "'@SUM(A1)"


# ------------------------------------------------- separation of duties on the gate


def test_the_submitter_may_not_review_the_draft_on_their_own_deal():
    """The human gate is not load-bearing if one person can both originate the
    deal and accept the agent draft on it (hardening rule 3)."""
    _submit("T-HARD-SOD", submitted_by="co.brennan")
    client.post("/deals/T-HARD-SOD/triage", json={"acting_user": "an.chen"})

    denied = client.post(
        "/deals/T-HARD-SOD/drafts/triage/review",
        json={"action": "accepted", "acting_user": "co.brennan"},
    )
    assert denied.status_code == 403
    assert "may not also review" in str(denied.json()["detail"])

    # the deal has NOT moved, and a different named human can still act
    assert client.get("/deals/T-HARD-SOD").json()["current_stage"] == "intake"
    allowed = client.post(
        "/deals/T-HARD-SOD/drafts/triage/review",
        json={"action": "accepted", "acting_user": "an.chen"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["current_stage"] == "document_extraction"


# ------------------------------------------------------------------ document blobs


def test_a_submission_cannot_pull_in_another_deals_stored_document():
    """Intake document text is confidential to its borrower: naming another
    deal's stored blob must yield nothing rather than copy it across."""
    _submit(
        "T-HARD-OWNER",
        documents=[
            {
                "document_type": "financial_statements",
                "original_filename": "secret.pdf",
                "text": "Balance Sheet: Total Debt 9,900,000. Current Assets 1,200,000.",
            }
        ],
    )
    victim_blob = client.get("/deals/T-HARD-OWNER").json()["documents"][0]["storage_path"]
    assert victim_blob and "T-HARD-OWNER" in victim_blob

    _submit(
        "T-HARD-THIEF",
        documents=[
            {
                "document_type": "financial_statements",
                "original_filename": "borrowed.pdf",
                "upload_name": victim_blob,
            }
        ],
    )
    thief = client.get("/deals/T-HARD-THIEF").json()
    assert thief["documents"][0]["storage_path"] is None  # nothing was copied across
    assert not uw.locations_for([thief["documents"][0]["id"]])


def test_an_operator_upload_is_still_readable_and_is_capped():
    """A genuine upload (not another deal's internal blob) still flows in, but
    only up to the intake character limit."""
    name = "operator-upload.txt"
    blob_store.save(name, ("Income Statement: Revenue 1,000. " * 20000).encode("utf-8"))
    text = uw._read_upload(name, "T-HARD-CAP")
    assert text.startswith("Income Statement: Revenue 1,000.")
    assert len(text) <= uw.MAX_DOCUMENT_TEXT
