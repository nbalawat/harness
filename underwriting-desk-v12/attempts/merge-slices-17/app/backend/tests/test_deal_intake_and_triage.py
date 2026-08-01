"""Tests for slice `deal-intake-and-triage`: deal submission, the Intake
Triage Agent, and the pipeline board."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def _submit_deal(borrower_name="Harborline Freight", industry="trucking", amount=400000):
    return client.post(
        "/api/deals",
        json={
            "borrower_name": borrower_name,
            "borrower_industry": industry,
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": "rm@bank.test",
        },
    )


def test_create_deal_enters_intake():
    resp = _submit_deal()
    assert resp.status_code == 201
    body = resp.json()
    assert body["borrower_name"] == "Harborline Freight"
    assert body["current_stage"] == "intake"
    assert body["deal_code"].startswith("DEAL-")


def test_create_deal_requires_authorized_role():
    import identity as identity_module

    identity_module.resolve_user("guest@bank.test", default_role="viewer")
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": "Some Borrower",
            "borrower_industry": "retail",
            "requested_amount": 10000,
            "exposure_amount": 10000,
            "acting_user_email": "guest@bank.test",
        },
    )
    assert resp.status_code == 403


def test_pipeline_lists_created_deal():
    created = _submit_deal(borrower_name="Pipeline Test Co").json()
    resp = client.get("/api/pipeline")
    assert resp.status_code == 200
    body = resp.json()
    codes = [d["deal_code"] for d in body["deals"]]
    assert created["deal_code"] in codes
    assert "intake" in body["columns"]


def test_triage_run_then_accept_routes_deal():
    deal = _submit_deal(borrower_name="Triage Flow Co").json()
    code = deal["deal_code"]

    run_resp = client.post(f"/api/deals/{code}/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"})
    assert run_resp.status_code == 200
    run_body = run_resp.json()
    for field in ("classification", "missing_documents", "recommended_queue", "confidence_score"):
        assert field in run_body
    assert 0 <= run_body["confidence_score"] <= 1
    assert run_body["recommended_queue"] in ("standard_underwriting_queue", "complex_credit_queue")

    accept_resp = client.post(f"/api/deals/{code}/triage/accept", json={"acting_user_email": "analyst@bank.test"})
    assert accept_resp.status_code == 200
    accept_body = accept_resp.json()
    assert accept_body["current_stage"] == "document_extraction"
    assert "queue_name" in accept_body

    pipeline = client.get("/api/pipeline", headers={"x-user-email": "analyst@bank.test"}).json()
    routed = next(d for d in pipeline["deals"] if d["deal_code"] == code)
    assert routed["current_stage"] == "document_extraction"
    assert routed["assigned_to_user_id"] is not None


def test_accept_without_prior_triage_run_is_rejected():
    deal = _submit_deal(borrower_name="No Triage Yet Co").json()
    code = deal["deal_code"]
    resp = client.post(f"/api/deals/{code}/triage/accept", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 409


def test_unknown_deal_404s():
    resp = client.post("/api/deals/DEAL-9999/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 404


def test_unknown_user_cannot_mutate():
    """Default-deny: an email that resolves to no stored user gets nothing."""
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": "Ghost Co",
            "borrower_industry": "retail",
            "requested_amount": 10000,
            "exposure_amount": 10000,
            "acting_user_email": "nobody@evil.test",
        },
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_relationship_manager_cannot_run_triage():
    deal = _submit_deal(borrower_name="Role Split Co").json()
    resp = client.post(
        f"/api/deals/{deal['deal_code']}/agents/intake-triage/run",
        json={"acting_user_email": "rm@bank.test"},
    )
    assert resp.status_code == 403
    assert "authority" in resp.json()["detail"]


def test_deal_book_is_scoped_for_a_relationship_manager():
    import identity as identity_module

    _submit_deal(borrower_name="Scoping Co")
    rm = identity_module.find_user("rm@bank.test")
    scoped = client.get("/api/deals", params={"acting_user_email": "rm@bank.test"})
    assert scoped.status_code == 200
    assert scoped.json(), "the RM should still see the deals it filed"
    assert all(d["created_by_user_id"] == rm["id"] for d in scoped.json())

    officer = client.get("/api/deals", params={"acting_user_email": "officer@bank.test"})
    assert officer.status_code == 200
    assert len(officer.json()) >= len(scoped.json())


def test_workflow_routes_are_not_shadowed_by_the_table_catch_all():
    """The /workflows router is mounted before the generic /api/{table}
    catch-all, so its routes resolve to the workflow engine."""
    resp = client.get("/workflows")
    assert resp.status_code == 200
    assert "workflows" in resp.json()


def test_missing_documents_reflects_attached_documents():
    deal = _submit_deal(borrower_name="Docs Co").json()
    code = deal["deal_code"]
    run_body = client.post(f"/api/deals/{code}/agents/intake-triage/run", json={"acting_user_email": "analyst@bank.test"}).json()
    assert set(run_body["missing_documents"]) == {"balance_sheet", "income_statement", "tax_return"}


# ---------------------------------------------------------------------------
# Hardened module surfaces (certified module catalog 0.12.1): every audit
# entry is attributable, workflow runs record who started/advanced them, and
# the two blob-write endpoints are identity-guarded like any other mutation.
# ---------------------------------------------------------------------------

def test_audit_entry_requires_an_actor():
    """An audit entry with no attributable actor is not an audit entry."""
    assert client.post("/audit", json={"event": "manual.check"}).status_code == 422
    entry = client.post("/audit", json={"event": "manual.check", "actor": "officer@bank.test"})
    assert entry.status_code == 200
    assert entry.json()["actor"] == "officer@bank.test"


def test_recorded_events_default_to_the_system_actor():
    import ext_audit

    assert ext_audit.record("machine.event", {"note": "no human involved"})["actor"] == "system"


def test_workflow_start_and_tick_record_who_drove_the_run():
    started = client.post(
        "/workflows/deal-underwriting-lifecycle/start",
        json={
            "acting_user_email": "rm@bank.test",
            "inputs": {
                "borrower_name": "Workflow Actor Co",
                "borrower_industry": "retail",
                "requested_amount": 50000,
                "exposure_amount": 50000,
                "acting_user_email": "rm@bank.test",
            },
        },
    )
    assert started.status_code == 200
    run_id = started.json()["run_id"]

    state = client.get(f"/workflows/runs/{run_id}").json()
    assert state["context"]["inputs"]["_started_by"] == "rm@bank.test"

    # tick accepts an actor body...
    ticked = client.post(f"/workflows/runs/{run_id}/tick", json={"acting_user_email": "analyst@bank.test"})
    assert ticked.status_code == 200
    assert any(
        e["event"] == "workflow.ticked" and e["actor"] == "analyst@bank.test"
        for e in client.get("/audit").json()
    )
    # ...and stays callable with no body at all (machine-driven ticks).
    assert client.post(f"/workflows/runs/{run_id}/tick").status_code == 200


def test_blob_and_upload_writes_require_a_known_identity():
    for path in ("/files/note.txt", "/uploads/note.txt"):
        anon = client.put(path, content=b"hello")
        assert anon.status_code == 401, path
        assert anon.json()["detail"] == "x-user-email header required for uploads", path
        denied = client.put(path, content=b"hello", headers={"x-user-email": "nobody@evil.test"})
        assert denied.status_code == 403, path
        assert "authority" in denied.json()["detail"]
        allowed = client.put(path, content=b"hello", headers={"x-user-email": "analyst@bank.test"})
        assert allowed.status_code == 200, path
        assert allowed.json()["bytes"] == 5
        assert allowed.json()["uploaded_by"] == "analyst@bank.test", path


def test_upload_extension_guard_still_applies_to_identified_callers():
    resp = client.put("/uploads/payload.exe", content=b"x", headers={"x-user-email": "analyst@bank.test"})
    assert resp.status_code == 415


def test_seed_endpoint_stays_hard_gated():
    assert client.post("/admin/seed").status_code == 403


# ---------------------------------------------------------------------------
# Fail-closed identity (governance code_audit HIGHs): reads are guarded
# unconditionally, approval decisions require a resolvable actor, the chat
# message is bounded, and a dropped audit row is never swallowed.
# ---------------------------------------------------------------------------

REDACTED_FIELDS = (
    "requested_amount",
    "exposure_amount",
    "risk_grade",
    "assigned_to_user_id",
    "created_by_user_id",
    "decline_reason_code",
)


def test_unidentified_reads_get_the_redacted_board_projection():
    """Omitting identity is not a way to read the whole book: the guard runs
    unconditionally and hands an unidentified caller stage + borrower name
    only — never amounts, owners, grades or adverse-action reasons."""
    _submit_deal(borrower_name="Redaction Co", amount=400000)

    board = client.get("/api/pipeline")
    assert board.status_code == 200
    body = board.json()
    assert body["scoped_to"] == "board_viewer"
    card = next(d for d in body["deals"] if d["borrower_name"] == "Redaction Co")
    assert card["current_stage"] == "intake"
    for field in REDACTED_FIELDS:
        assert field not in card, field

    book = client.get("/api/deals")
    assert book.status_code == 200
    assert book.json(), "the board projection is still a readable board"
    for row in book.json():
        for field in REDACTED_FIELDS:
            assert field not in row, field


def test_identified_desk_reads_are_unredacted():
    created = _submit_deal(borrower_name="Full Read Co", amount=400000).json()

    for read in (
        client.get("/api/pipeline", headers={"x-user-email": "analyst@bank.test"}),
        client.get("/api/pipeline", params={"acting_user_email": "officer@bank.test"}),
    ):
        assert read.status_code == 200
        assert read.json()["scoped_to"] in ("credit_analyst", "senior_credit_officer")
        card = next(d for d in read.json()["deals"] if d["deal_code"] == created["deal_code"])
        assert card["requested_amount"] == 400000
        assert "created_by_user_id" in card


def test_reads_by_an_unknown_identity_are_refused_not_downgraded():
    """A forged identity must 403 — never fall back to a wider view."""
    for path in ("/api/deals", "/api/pipeline"):
        forged = client.get(path, headers={"x-user-email": "nobody@evil.test"})
        assert forged.status_code == 403, path
        assert "authority" in forged.json()["detail"]


def test_relationship_manager_reads_stay_scoped_on_the_board_too():
    import identity as identity_module

    _submit_deal(borrower_name="RM Scope Co")
    rm = identity_module.find_user("rm@bank.test")
    board = client.get("/api/pipeline", headers={"x-user-email": "rm@bank.test"})
    assert board.status_code == 200
    deals = board.json()["deals"]
    assert deals, "the RM still sees the deals it filed"
    assert all(
        d["created_by_user_id"] == rm["id"] or d["assigned_to_user_id"] == rm["id"]
        for d in deals
    )


def test_approval_decisions_require_a_resolvable_actor():
    submitted = client.post(
        "/workflow/submissions",
        json={"kind": "deal", "payload": {"note": "x"}, "by": "analyst@bank.test"},
    )
    assert submitted.status_code == 200
    item_id = submitted.json()["id"]

    for action in ("approve", "reject"):
        path = f"/workflow/submissions/{item_id}/{action}"
        assert client.post(path, json={"reason": "no actor"}).status_code == 422
        anonymous = client.post(path, json={"actor": "", "reason": "anonymous"})
        assert anonymous.status_code == 401, action
        forged = client.post(path, json={"actor": "nobody@evil.test"})
        assert forged.status_code == 403, action

    decided = client.post(
        f"/workflow/submissions/{item_id}/approve",
        json={"actor": "officer@bank.test", "reason": "within policy"},
    )
    assert decided.status_code == 200
    assert decided.json()["decided_by"] == "officer@bank.test"


def test_approval_submission_requires_a_resolvable_submitter():
    anonymous = client.post("/workflow/submissions", json={"kind": "deal", "payload": {}, "by": ""})
    assert anonymous.status_code == 401
    forged = client.post("/workflow/submissions", json={"kind": "deal", "payload": {}, "by": "nobody@evil.test"})
    assert forged.status_code == 403


def test_chat_message_length_is_bounded():
    import main

    too_long = "x" * (main.MAX_CHAT_MESSAGE_CHARS + 1)
    assert client.post("/chat", json={"message": too_long}).status_code == 422
    assert client.post("/chat", json={"message": ""}).status_code == 422
    assert client.post("/chat", json={"message": "hello"}).status_code == 200


def test_audit_store_failures_are_not_swallowed():
    """A durable audit row that cannot be written must fail loudly."""
    import ext_audit
    from db import store as real_store

    original = real_store.insert

    def exploding_insert(table, row):
        if table == "audit_log":
            raise RuntimeError("audit store unavailable")
        return original(table, row)

    real_store.insert = exploding_insert
    try:
        try:
            ext_audit.record("deal.something", {"deal_id": "DEAL-0000"}, actor="officer@bank.test")
        except RuntimeError as exc:
            assert "audit store unavailable" in str(exc)
        else:
            raise AssertionError("record() swallowed a failed audit write")
    finally:
        real_store.insert = original
