"""Slice 1 — FSI hardening behaviours added on review.

Same style as the rest of the suite: stub agent mode pinned, TestClient over
the composed app. Each test pins one convention that a reviewer flagged as
bypassable, so a later slice cannot quietly regress it.
"""
import json
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


# --------------------------------------------------------------------------
# Row-level scoping: a relationship manager sees only their own book (REQ-019)
# --------------------------------------------------------------------------


def _login(username):
    token = client.post("/auth/login", json={"username": username}).json()["token"]
    return {"Authorization": "Bearer " + token}


def test_relationship_manager_sees_only_the_deals_they_submitted():
    client.post("/deals", json={**BASE, "deal_reference": "T-RLS-MINE", "borrower_name": "Mine LLC", "submitted_by": "rm.rivera"})
    client.post("/deals", json={**BASE, "deal_reference": "T-RLS-THEIRS", "borrower_name": "Theirs LLC", "submitted_by": "co.brennan"})

    scoped = client.get("/deals", headers=_login("rm.rivera")).json()
    refs = {d["deal_reference"] for d in scoped}
    assert "T-RLS-MINE" in refs
    assert "T-RLS-THEIRS" not in refs
    assert all(d["submitted_by_user_id"] == "rm.rivera" for d in scoped)

    # the board export and the pipeline board are scoped by the same rule
    assert "T-RLS-THEIRS" not in client.get("/deals/export.csv", headers=_login("rm.rivera")).text
    board = client.get("/pipeline", headers=_login("rm.rivera")).json()
    assert "T-RLS-THEIRS" not in {d["deal_reference"] for d in board["deals"]}


def test_credit_officer_sees_the_whole_book():
    refs = {d["deal_reference"] for d in client.get("/deals", headers=_login("co.brennan")).json()}
    assert {"T-RLS-MINE", "T-RLS-THEIRS"} <= refs


def test_pipeline_totals_never_count_drafts_the_caller_cannot_see():
    """A scoped board must not leak the existence of other people's work."""
    board = client.get("/pipeline", headers=_login("rm.rivera")).json()
    visible = {d["id"] for d in board["deals"]}
    pending = [d for d in uw.store.list("agent_drafts") if d.get("review_status") == "pending"]
    assert board["totals"]["pending_drafts"] == len([d for d in pending if d["deal_id"] in visible])
    assert board["totals"]["active_deals"] == len([d for d in board["deals"] if not d["is_closed"]])


def test_generic_read_of_a_governed_table_is_scrubbed_but_still_readable():
    rows = client.get("/api/deals").json()
    assert isinstance(rows, list) and rows
    assert all("borrower_tin" not in row for row in rows)


def test_generic_api_refusal_is_itself_audited():
    import ext_audit

    before = len(ext_audit.list_entries())
    assert client.post("/api/deals", json={"deal_reference": "T-NOPE"}).status_code == 403
    entries = ext_audit.list_entries()
    assert len(entries) > before
    assert entries[0]["event"] == "api.generic_write_refused"
    assert entries[0]["detail"]["table"] == "deals"


def test_a_non_utf8_upload_goes_through_the_composed_doc_extract_module():
    """The intake screen asks for PDF/DOCX. Those are not utf-8 text, so the
    document must not land with zero extractable content."""
    name = "T-HARD-DOCX-01-statements.docx"
    import io as _io
    import zipfile as _zip

    buf = _io.BytesIO()
    with _zip.ZipFile(buf, "w") as z:
        z.writestr(
            "word/document.xml",
            "<w:document><w:body><w:p><w:t>Income Statement: Revenue 9,900,000</w:t></w:p>"
            "<w:p><w:t>EBITDA 1,250,000</w:t></w:p></w:body></w:document>",
        )
    blob_store.save(name, buf.getvalue())
    text = uw._read_upload(name, "T-HARD-DOCX")
    assert "Revenue 9,900,000" in text
    assert "EBITDA 1,250,000" in text


def test_an_unreadable_upload_degrades_to_empty_rather_than_500ing():
    """Invalid utf-8 in an unsupported container: doc-extract reports it cannot
    read the format and the request survives with no document text."""
    blob_store.save("T-HARD-BIN-01-scan.bin", b"\xff\xfe\x00\x03 not decodable")
    assert uw._read_upload("T-HARD-BIN-01-scan.bin", "T-HARD-BIN") == ""


def test_a_pdf_upload_reports_rather_than_silently_dropping_its_content():
    """Without poppler, doc-extract warns instead of returning fake text."""
    blob_store.save("T-HARD-PDF-01-fin.pdf", b"%PDF-1.4\n\xff\xfe binary body")
    assert uw._read_upload("T-HARD-PDF-01-fin.pdf", "T-HARD-PDF") == ""


def test_upload_extraction_cannot_escape_the_blob_directory():
    assert uw._read_upload("../../../../etc/passwd", "T-HARD-TRAV") == ""


# --------------------------------------------------------------------------
# The human gate has exactly one door
# --------------------------------------------------------------------------


def test_the_raw_approval_api_cannot_dispose_of_an_agent_draft_gate():
    ref = "T-HARD-GATE2"
    created = client.post("/deals", json={**BASE, "deal_reference": ref, "borrower_name": "Gate LLC", "submitted_by": "rm.rivera"}).json()
    item_id = created["triage_draft"]["approval_item_id"]

    for verb in ("approve", "reject"):
        refused = client.post(f"/workflow/submissions/{item_id}/{verb}", json={"actor": "anyone", "reason": "x"})
        assert refused.status_code == 403, verb
        assert "governed human gate" in refused.json()["detail"]

    # the draft is untouched and the owning endpoint still works
    assert uw.pending_draft(uw.find_deal(ref)["id"], "triage") is not None
    ok = client.post(f"/deals/{ref}/drafts/triage/review", json={"action": "accepted", "acting_user": "an.chen"})
    assert ok.status_code == 200
    assert ok.json()["draft"]["reviewed_by_user_id"] == "an.chen"


def test_an_intake_draft_never_stores_a_full_tin():
    ref = "T-HARD-DRAFT-TIN"
    saved = client.post(
        "/intake/drafts",
        json={"deal_reference": ref, "acting_user": "rm.rivera", "content": {"borrower_name": "X LLC", "borrower_tin": "56-2841907"}},
    )
    assert saved.status_code == 200
    content = client.get(f"/intake/drafts/{ref}").json()["content"]
    assert "borrower_tin" not in content
    assert content["borrower_tin_masked"] == "***-**1907"
    assert "56-2841907" not in json.dumps(content)


def test_the_workflow_run_record_does_not_double_as_a_document_dump():
    ref = "T-HARD-RUNDUMP"
    secret = "CONFIDENTIAL BORROWER LEDGER 998877"
    created = client.post(
        "/deals",
        json={
            **BASE,
            "deal_reference": ref,
            "borrower_name": "Dump LLC",
            "submitted_by": "rm.rivera",
            "documents": [{"document_type": "financial_statements", "original_filename": "f.pdf", "content_type": "application/pdf", "text": secret}],
        },
    ).json()
    body = json.dumps(client.get(f"/workflows/runs/{created['workflow']['run_id']}").json())
    assert secret not in body
    assert "redacted" in body


def test_unbounded_borrower_strings_are_refused():
    for field in ("borrower_industry", "borrower_state"):
        refused = client.post("/deals", json={**BASE, "deal_reference": "T-HARD-LONG", "borrower_name": "L LLC", "submitted_by": "rm.rivera", field: "A" * 5000})
        assert refused.status_code == 400
        assert field in refused.json()["detail"]


def test_scoping_holds_on_the_single_deal_read_too():
    """Naming a reference must not walk around the board's row scoping."""
    client.post("/deals", json={**BASE, "deal_reference": "T-RLS-SOLO", "borrower_name": "Solo LLC", "submitted_by": "co.brennan"})
    assert client.get("/deals/T-RLS-SOLO", headers=_login("rm.rivera")).status_code == 404
    assert client.get("/deals/T-RLS-SOLO", headers=_login("co.brennan")).status_code == 200
    # the documented unauthenticated contract for this slice is unchanged
    assert client.get("/deals/T-RLS-SOLO").status_code == 200


def test_borrower_document_text_is_not_reachable_through_generic_surfaces():
    ref = "T-HARD-LEAK"
    secret = "CONFIDENTIAL LEDGER 553311"
    client.post("/deals", json={**BASE, "deal_reference": ref, "borrower_name": "Leak LLC", "submitted_by": "rm.rivera",
                                "documents": [{"document_type": "financial_statements", "original_filename": "f.pdf", "text": secret}]})
    blob = client.get(f"/deals/{ref}").json()["documents"][0]["storage_path"]
    assert blob
    assert client.get(f"/files/{blob}").status_code == 403
    assert secret not in json.dumps(client.get("/api/document_locations").json())
    assert secret not in client.get("/export/document_locations.csv").text


def test_the_audit_trail_cannot_be_posted_to_directly():
    refused = client.post("/audit", json={"event": "workflow.approved", "detail": {"by": "forged"}})
    assert refused.status_code == 403
    assert "append-only" in refused.json()["detail"]


def test_a_generic_submission_rejection_still_needs_a_reason():
    item = client.post("/workflow/submissions", json={"kind": "note", "payload": {}, "by": "an.chen"}).json()
    assert client.post(f"/workflow/submissions/{item['id']}/reject", json={"actor": "an.chen"}).status_code == 400
    ok = client.post(f"/workflow/submissions/{item['id']}/reject", json={"actor": "an.chen", "reason": "not needed"})
    assert ok.status_code == 200
    assert ok.json()["status"] == "rejected"
