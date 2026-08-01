"""Tests for slice `memo-policy-and-audit-trail`: the Credit Memo Agent, the
Policy Compliance Agent, and the per-deal audit chronicle.

DEAL-1003 (the code the slice acceptance drives directly) is asserted only
structurally here — in the full backend test suite, `test_deal_intake_and_
triage.py` runs first and, via the ordinary DEAL-1001/1002/1003/... sequence,
may already have claimed that exact code for one of its own fixture-less
deals before this module ever imports. `ext_memo_policy._ensure_fixture_deal`
is written to cope with that (see its docstring): it backfills underwriting
inputs onto whichever deal already holds DEAL-1003 rather than assuming it
owns that identity. So correctness assertions that depend on a *specific*
borrower/industry (prohibited-industry detection, memo content matching a
known borrower name) use a freshly created deal of their own instead of
hard-coding DEAL-1003's borrower identity.
"""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

FIXTURE_DEAL = "DEAL-1003"


def _submit_deal(borrower_name, industry="retail", amount=50000):
    return client.post(
        "/api/deals",
        json={
            "borrower_name": borrower_name,
            "borrower_industry": industry,
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": "rm@bank.test",
        },
    ).json()


def _run_memo(deal_code=FIXTURE_DEAL, email="analyst@bank.test"):
    return client.post(f"/api/deals/{deal_code}/agents/credit-memo/run", json={"acting_user_email": email})


def _run_policy(deal_code=FIXTURE_DEAL, email="analyst@bank.test"):
    return client.post(f"/api/deals/{deal_code}/agents/policy-compliance/run", json={"acting_user_email": email})


def test_credit_memo_run_on_the_acceptance_deal_succeeds():
    resp = _run_memo()
    assert resp.status_code == 200
    body = resp.json()
    for field in ("memo_content", "citations", "sections"):
        assert field in body
    codes = {d["deal_code"] for d in client.get("/api/pipeline").json()["deals"]}
    assert FIXTURE_DEAL in codes
    # idempotent: re-running the fixture-seed path never duplicates the deal
    codes_twice = [d["deal_code"] for d in client.get("/api/pipeline").json()["deals"]]
    assert codes_twice.count(FIXTURE_DEAL) == 1


def test_credit_memo_agent_cites_ratios_spread_and_grade():
    resp = _run_memo()
    assert resp.status_code == 200
    body = resp.json()
    assert body["memo_content"]  # non-empty
    deal = next(d for d in client.get("/api/pipeline").json()["deals"] if d["deal_code"] == FIXTURE_DEAL)
    assert deal["borrower_name"] in body["memo_content"]
    refs = {c["ref"] for c in body["citations"]}
    assert "ratio:dscr" in refs
    assert "risk_grade" in refs
    assert any(r.startswith("spread:") for r in refs)
    assert len(body["sections"]) >= 3
    # no approval/decline recommendation ever leaks into the memo
    lowered = body["memo_content"].lower()
    assert "we recommend approval" not in lowered
    assert "approve this deal" not in lowered


def test_credit_memo_requires_prerequisites():
    deal = _submit_deal("No Ratios Yet Co")
    resp = client.post(f"/api/deals/{deal['deal_code']}/agents/credit-memo/run", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 409


def test_memo_accept_requires_a_prior_run():
    deal = _submit_deal("No Memo Yet Co")
    resp = client.post(f"/api/deals/{deal['deal_code']}/memo/accept", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 409


def test_memo_accept_advances_stage_and_writes_review():
    _run_memo()
    resp = client.post(f"/api/deals/{FIXTURE_DEAL}/memo/accept", json={"acting_user_email": "analyst@bank.test"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["review_id"] is not None
    deal = next(d for d in client.get("/api/pipeline").json()["deals"] if d["deal_code"] == FIXTURE_DEAL)
    assert deal["current_stage"] == "policy_compliance"


def test_policy_compliance_flags_prohibited_industry():
    deal = _submit_deal("Verdant Leaf Co", industry="cannabis_dispensary", amount=250000)
    resp = _run_policy(deal_code=deal["deal_code"])
    assert resp.status_code == 200
    body = resp.json()
    for field in ("findings", "exceptions", "policy_version", "narrative"):
        assert field in body
    assert body["policy_version"] == "v4.2"
    prohibited = next(e for e in body["exceptions"] if "PROHIBITED-IND" in e["rule_reference"])
    assert "cannabis_dispensary" in prohibited["violation_detail"]
    assert prohibited["rationale"]
    # every finding cites a rule reference that exists in the ruleset (no invented rules)
    rule_refs = {r["rule_key"] for r in client.get("/api/lending_policy").json()}
    for f in body["findings"]:
        assert f["rule_reference"] in rule_refs

    exceptions_resp = client.get(f"/api/deals/{deal['deal_code']}/policy-exceptions")
    assert exceptions_resp.status_code == 200
    exceptions = exceptions_resp.json()["exceptions"]
    assert exceptions
    for exc in exceptions:
        assert exc["rule_reference"]
        assert exc["rationale"]
        assert exc["status"] == "open"


def test_compliant_deal_raises_no_exceptions():
    deal = _submit_deal("Plain Vanilla Retail Co", industry="retail", amount=40000)
    resp = _run_policy(deal_code=deal["deal_code"])
    assert resp.status_code == 200
    body = resp.json()
    assert body["exceptions"] == []
    statuses = {f["rule_reference"]: f["status"] for f in body["findings"]}
    assert statuses["PROHIBITED-IND-01"] == "passed"
    # LTV cannot be evaluated without an appraisal on file — never silently "passed"
    assert statuses["LTV-CAP-01"] == "unevaluated"


def test_policy_compliance_on_the_acceptance_deal_returns_structured_body():
    resp = _run_policy()
    assert resp.status_code == 200
    body = resp.json()
    for field in ("findings", "exceptions", "policy_version"):
        assert field in body
    assert body["findings"]
    for f in body["findings"]:
        assert "rule_reference" in f

    exceptions_resp = client.get(f"/api/deals/{FIXTURE_DEAL}/policy-exceptions")
    assert exceptions_resp.status_code == 200
    assert "exceptions" in exceptions_resp.json()


def test_audit_timeline_is_ordered_and_includes_agent_drafts():
    _run_memo()
    _run_policy()
    resp = client.get(f"/api/deals/{FIXTURE_DEAL}/audit")
    assert resp.status_code == 200
    body = resp.json()
    entries = body["entries"]
    assert entries
    for e in entries:
        for field in ("actor_user_id", "action", "resource_type", "timestamp"):
            assert field in e
    assert any(e["resource_type"] == "agent_draft" for e in entries)
    ids = [e["id"] for e in entries]
    assert ids == sorted(ids)  # append-only, chronological


def test_unknown_deal_404s_on_memo_and_audit():
    assert client.post("/api/deals/DEAL-9999/agents/credit-memo/run", json={"acting_user_email": "analyst@bank.test"}).status_code == 404
    assert client.get("/api/deals/DEAL-9999/audit").status_code == 404


def test_memo_and_policy_require_authorized_role():
    import identity as identity_module

    identity_module.resolve_user("outsider@bank.test", default_role="relationship_manager")
    assert _run_memo(email="outsider@bank.test").status_code == 403
    assert _run_policy(email="outsider@bank.test").status_code == 403
