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


def test_answer_is_grounded_in_live_deal_records():
    """The desk answers portfolio questions from the stored deals — real deal
    codes and real figures — instead of refusing them as uncovered."""
    deal = _submit_deal("Grounding Fixture Freight", amount=512000)
    resp = client.post(
        "/api/qa/ask",
        json={"question": "Which deals await tiered approval?", "acting_user_email": "officer@bank.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    answer = body["answer"]
    # nothing sits at tiered approval yet, so the desk says so honestly —
    # and still grounds that statement in the deals it actually read.
    assert "DEAL-" in answer
    assert deal["deal_code"] in body["source_deal_ids"]
    assert set(body["cited_record_refs"]).issubset(set(body["source_deal_ids"]))

    resp2 = client.post(
        "/api/qa/ask",
        json={
            "question": "What is the status of Grounding Fixture Freight?",
            "acting_user_email": "officer@bank.test",
        },
    )
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["source_deal_ids"] == [deal["deal_code"]]
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
