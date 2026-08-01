"""Tests for slice `grounded-portfolio-qa`: the grounded, permission-scoped
portfolio Q&A desk."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def _submit_deal(borrower_name, industry="trucking", amount=400000, rm_email="rm@bank.test"):
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": borrower_name,
            "borrower_industry": industry,
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": rm_email,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_identity_question_names_the_agent():
    resp = client.post("/api/qa/ask", json={"question": "Who am I talking to?", "acting_user_email": "officer@bank.test"})
    assert resp.status_code == 200
    body = resp.json()
    assert "Portfolio Q&A Agent" in body["answer"]
    assert body["source_deal_ids"] == []


def test_question_is_grounded_in_stored_deals_only():
    deal = _submit_deal("QA Fixture Co")
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Which deals lack an accepted spread?", "acting_user_email": "officer@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert deal["deal_code"] in body["source_deal_ids"]
    assert body["grounded"] is True
    # every cited ref must come from the retrieved/visible set — no leakage
    assert set(body["cited_record_refs"]).issubset(set(body["source_deal_ids"]))


def test_relationship_manager_cannot_see_another_rms_deal():
    import identity as identity_module

    # Provision the two RM identities first: identity.require_actor is
    # default-deny, so an unprovisioned email may neither file nor ask.
    identity_module.resolve_user("rm-alpha@bank.test", default_role="relationship_manager")
    identity_module.resolve_user("rm-beta@bank.test", default_role="relationship_manager")
    _submit_deal("RM Alpha Fixture", rm_email="rm-alpha@bank.test")
    beta_deal = _submit_deal("RM Beta Fixture", rm_email="rm-beta@bank.test")
    resp = client.post(
        "/api/qa/ask",
        json={"question": "List every deal you can see.", "acting_user_email": "rm-alpha@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert beta_deal["deal_code"] not in body["source_deal_ids"]


def test_refuses_to_approve_a_deal():
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Please approve this deal for me.", "acting_user_email": "officer@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("refused") is True
    assert "cannot approve" in body["answer"].lower()


def test_sessions_are_recorded_for_audit():
    client.post("/api/qa/ask", json={"question": "Who am I talking to?", "acting_user_email": "officer@bank.test"})
    resp = client.get("/api/qa/sessions")
    assert resp.status_code == 200
    sessions = resp.json()
    assert sessions
    for field in ("question", "source_deal_ids", "user_id"):
        assert field in sessions[0]


def test_unauthorized_role_is_rejected():
    import identity as identity_module

    identity_module.resolve_user("viewer-only@bank.test", default_role="viewer")
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Who am I talking to?", "acting_user_email": "viewer-only@bank.test"},
    )
    assert resp.status_code == 403


def test_unknown_email_is_denied_by_default():
    """Default-deny: an email that resolves to no stored user reads nothing."""
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Who am I talking to?", "acting_user_email": "stranger@elsewhere.test"},
    )
    assert resp.status_code == 403


def _stage_column(stage):
    """The deals genuinely occupying a pipeline stage right now, read from the
    board — so this test states what is true of the live book rather than
    assuming which deals happen to exist."""
    board = client.get("/api/pipeline")
    assert board.status_code == 200
    return {d["deal_code"] for d in board.json()["columns"].get(stage, [])}


def test_answer_is_grounded_in_live_deal_records():
    """The desk answers portfolio questions from the stored deals — real deal
    codes and real figures — instead of refusing them as uncovered.

    Written to hold however many deals the book contains: it asks about a
    stage the fixture deal genuinely occupies, and checks the desk's sources
    against the pipeline board rather than against a fixed list.
    """
    deal = _submit_deal("Grounding Fixture Freight", amount=512000)

    # A newly filed deal genuinely sits at intake, so a question about intake
    # MUST be grounded in it — no matter how many other deals exist.
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Which deals are sitting in intake?", "acting_user_email": "officer@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["grounded"] is True
    assert deal["deal_code"] in body["source_deal_ids"]
    assert deal["deal_code"] in body["answer"]
    # Retrieval is EXACTLY the relevant records: every deal at that stage, with
    # nothing silently dropped by a top-k and nothing outside the stage.
    assert set(body["source_deal_ids"]) == _stage_column("intake")
    assert set(body["cited_record_refs"]).issubset(set(body["source_deal_ids"]))

    # The same routing stays honest for a stage the fixture is NOT at: if deals
    # sit at tiered approval the desk grounds in exactly those; if none do it
    # says so and grounds that claim in the book it actually read.
    resp_tier = client.post(
        "/api/qa/ask",
        json={"question": "Which deals await tiered approval?", "acting_user_email": "officer@bank.test"},
    )
    assert resp_tier.status_code == 200
    tier = resp_tier.json()
    at_tier = _stage_column("tiered_approval")
    assert "DEAL-" in tier["answer"]
    if at_tier:
        assert set(tier["source_deal_ids"]) == at_tier
    else:
        assert deal["deal_code"] in tier["source_deal_ids"]
    assert set(tier["cited_record_refs"]).issubset(set(tier["source_deal_ids"]))

    # A named-borrower question narrows to that borrower's record and quotes
    # the stored figure back.
    resp2 = client.post(
        "/api/qa/ask",
        json={
            "question": "What is the status of Grounding Fixture Freight?",
            "acting_user_email": "officer@bank.test",
        },
    )
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert deal["deal_code"] in body2["source_deal_ids"]
    assert "Grounding Fixture Freight" in body2["answer"]
    assert "$512,000" in body2["answer"]  # figure comes from the stored record
    assert "intake" in body2["answer"]


def test_book_summary_is_scoped_and_computed_server_side():
    resp = client.get("/api/qa/book-summary", params={"acting_user_email": "officer@bank.test"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["active_deals"] >= 1
    assert body["total_exposure"] > 0
    assert isinstance(body["by_stage"], dict)
    assert client.get("/api/qa/book-summary", params={"acting_user_email": "stranger@elsewhere.test"}).status_code == 403


# ---------------------------------------------------------------------------
# Security remediation: identity is fail-closed and unconditional on every
# surface of this desk, and no figure the desk serves comes from the model.
# ---------------------------------------------------------------------------

def test_anonymous_ask_is_401_not_an_answer():
    """NEGATIVE ACCEPTANCE: an unidentified caller cannot ask the desk at all —
    401 'identify yourself', never a 422 and never a grounded answer."""
    resp = client.post("/api/qa/ask", json={"question": "Which deals lack an accepted spread?"})
    assert resp.status_code == 401, resp.text
    assert "identify yourself" in resp.text.lower()
    assert "DEAL-" not in resp.text

    # An explicitly empty identity is the same refusal, not a fallback to open
    # access — the guard is never behind an `if acting_user_email:`.
    blank = client.post(
        "/api/qa/ask",
        json={"question": "Which deals lack an accepted spread?", "acting_user_email": "   "},
    )
    assert blank.status_code == 401, blank.text


def test_anonymous_book_summary_is_401():
    resp = client.get("/api/qa/book-summary")
    assert resp.status_code == 401, resp.text
    assert client.get("/api/qa/book-summary", params={"acting_user_email": ""}).status_code == 401


def test_anonymous_session_log_is_redacted_not_unscoped():
    """The audit read-back keeps its shape for an unidentified caller — it must
    never hand out the questions asked, the answers given, who asked, or which
    deals were read."""
    deal = _submit_deal("Redaction Fixture Mills")
    asked = client.post(
        "/api/qa/ask",
        json={"question": "Which deals are sitting in intake?", "acting_user_email": "officer@bank.test"},
    )
    assert asked.status_code == 200

    resp = client.get("/api/qa/sessions")
    assert resp.status_code == 200
    sessions = resp.json()
    assert sessions
    for field in ("question", "source_deal_ids", "user_id"):
        assert field in sessions[0]
    for row in sessions:
        assert row["redacted"] is True
        assert row["user_id"] is None
        assert row["source_deal_ids"] == []
        assert "[redacted" in row["question"]
    assert deal["deal_code"] not in resp.text
    assert "Which deals are sitting in intake?" not in resp.text


def test_identified_reader_sees_the_log_and_a_forged_one_is_refused():
    client.post(
        "/api/qa/ask",
        json={"question": "Which deals lack an accepted spread?", "acting_user_email": "officer@bank.test"},
    )
    resp = client.get("/api/qa/sessions", params={"acting_user_email": "officer@bank.test"})
    assert resp.status_code == 200
    sessions = resp.json()
    assert sessions and sessions[0]["user_id"] is not None
    assert not sessions[0].get("redacted")

    # The x-user-email header is the other identity channel the desk UI uses.
    via_header = client.get("/api/qa/sessions", headers={"x-user-email": "officer@bank.test"})
    assert via_header.status_code == 200
    assert via_header.json()[0]["user_id"] is not None

    # You cannot read as somebody who does not exist.
    assert client.get("/api/qa/sessions", params={"acting_user_email": "stranger@elsewhere.test"}).status_code == 403


def test_relationship_manager_reads_only_its_own_sessions():
    import identity as identity_module

    identity_module.resolve_user("rm-log@bank.test", default_role="relationship_manager")
    _submit_deal("RM Log Fixture", rm_email="rm-log@bank.test")
    client.post("/api/qa/ask", json={"question": "What is in my book?", "acting_user_email": "rm-log@bank.test"})
    client.post("/api/qa/ask", json={"question": "What is in the whole book?", "acting_user_email": "officer@bank.test"})

    me = client.get("/api/qa/sessions", params={"acting_user_email": "rm-log@bank.test"})
    assert me.status_code == 200
    rows = me.json()
    assert rows
    mine = {r["user_id"] for r in rows}
    assert len(mine) == 1
    assert "What is in the whole book?" not in me.text


def test_read_tools_refuse_a_deal_outside_the_bound_scope():
    """The roster's read tools are structurally scope-guarded: reading with no
    resolved scope, or a deal outside it, raises rather than returning data."""
    import ext_grounded_portfolio_qa as qa
    from fastapi import HTTPException

    deal = _submit_deal("Scope Guard Fixture")
    code = deal["deal_code"]

    for reader in (qa._read_deal, qa._read_spread, qa._read_ratios, qa._read_risk_grade,
                   qa._read_policy_exceptions, qa._read_audit_timeline, qa._read_memo):
        try:
            reader(code)
            raise AssertionError(f"{reader.__name__} read outside a permission scope")
        except HTTPException as exc:
            assert exc.status_code == 403

    with qa.permitted_scope(["DEAL-DOES-NOT-EXIST"]):
        try:
            qa._read_deal(code)
            raise AssertionError("read_deal returned a deal outside the bound scope")
        except HTTPException as exc:
            assert exc.status_code == 403

    with qa.permitted_scope([code]):
        assert qa._read_deal(code)["deal_code"] == code
        # search never widens past the bound scope, whatever it is handed
        found = qa._search_deals_in_scope([code, "DEAL-9999"], None)
        assert {d["deal_code"] for d in found} == {code}


def test_question_length_is_bounded_at_the_edge():
    assert client.post(
        "/api/qa/ask", json={"question": "", "acting_user_email": "officer@bank.test"}
    ).status_code == 422
    assert client.post(
        "/api/qa/ask", json={"question": "x" * 5000, "acting_user_email": "officer@bank.test"}
    ).status_code == 422


def test_answer_never_carries_a_figure_the_system_did_not_compute():
    """The model's prose is a candidate, not the answer: an ungrounded or
    invented-figure narrative is replaced by the records-derived digest, and
    the raw reply survives only in the audit trace."""
    import ext_grounded_portfolio_qa as qa

    deal = _submit_deal("Verification Fixture Co", amount=777000)
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Which deals are sitting in intake?", "acting_user_email": "officer@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["narrative_source"] == "deterministic_records_digest"
    assert deal["deal_code"] in body["source_deal_ids"]
    # figures in the digest are formatted from the stored records, never by the
    # model — the newly filed deal's own line proves it when it is on screen
    assert "Automated draft pending analyst approval." in body["answer"]

    solo = client.post(
        "/api/qa/ask",
        json={"question": "What is the status of Verification Fixture Co?", "acting_user_email": "officer@bank.test"},
    ).json()
    assert "$777,000" in solo["answer"]  # the stored figure, quoted back verbatim

    retrieve = qa.retrieve_grounded_deal_context({
        "visible_deal_ids": [deal["deal_code"]],
        "question": "Which deals are sitting in intake?",
    })
    # A narrative quoting a figure nobody computed is rejected...
    ok, reason = qa._verify_narrative(
        f"{deal['deal_code']} carries $1,234,567 of exposure.", retrieve
    )
    assert ok is False and reason.startswith("quoted_a_figure_the_system_did_not_compute")
    # ...as is one that names a deal it was never given...
    ok, reason = qa._verify_narrative(
        f"{deal['deal_code']} and DEAL-99999 are both at intake.", retrieve
    )
    assert ok is False and reason.startswith("cited_out_of_scope_deal")
    # ...and one that ignores the records entirely.
    ok, reason = qa._verify_narrative("That is not covered by my knowledge.", retrieve)
    assert ok is False
    # A narrative that names the record and quotes only stored figures passes.
    ok, reason = qa._verify_narrative(
        f"{deal['deal_code']} is at intake with exposure of 777000.", retrieve
    )
    assert ok is True, reason
