"""Tests for slice `memo-policy-and-audit-trail`: the Credit Memo Agent, the
Policy Compliance Agent and its formal exceptions, and the per-deal chronicle."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

DEAL = "DEAL-1003"
ANALYST = {"acting_user_email": "analyst@bank.test"}
OFFICER = {"acting_user_email": "officer@bank.test"}
AS_ANALYST = {"acting_user_email": "analyst@bank.test"}  # query params for reads
FIXTURE_CODE = DEAL


# ---------------------------------------------------------------------------
# Credit memo
# ---------------------------------------------------------------------------

def test_memo_run_returns_content_sections_and_citations():
    resp = client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    assert resp.status_code == 200
    body = resp.json()
    for field in ("memo_content", "citations", "sections"):
        assert field in body
    assert body["memo_content"]
    assert body["review_required"] is True


def test_every_memo_section_carries_at_least_one_citation():
    body = client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST).json()
    refs = {c["ref"] for c in body["citations"]}
    for section in body["sections"]:
        assert section["citations"], f"section {section['key']} has no citation"
        for ref in section["citations"]:
            assert ref in refs


def test_memo_states_the_assigned_grade_and_the_computed_ratios_verbatim():
    """The agent may never recompute a figure or restate a different grade."""
    body = client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST).json()
    content = body["memo_content"]
    assert "1.24" in content and "3.1" in content and "1.42" in content
    assert "risk grade 4" in content
    assert "band_4_watch" in content
    lowered = content.lower()
    for banned in ("we recommend approval", "approve this deal", "decline this deal"):
        assert banned not in lowered


def test_memo_draft_is_not_accepted_until_a_human_accepts_it():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    assert client.get(f"/api/deals/{DEAL}/memo", params=AS_ANALYST).json()["status"] == "proposed"
    accepted = client.post(f"/api/deals/{DEAL}/memo/accept", json=ANALYST)
    assert accepted.status_code == 200
    body = accepted.json()
    assert body["status"] == "accepted"
    assert body["memo_id"] and body["review_id"] and body["citation_ids"]
    assert client.get(f"/api/deals/{DEAL}/memo", params=AS_ANALYST).json()["status"] == "accepted"


def test_memo_accept_without_a_draft_is_rejected():
    fresh = _file_deal("Memo Order Co")
    resp = client.post(f"/api/deals/{fresh}/memo/accept", json=ANALYST)
    assert resp.status_code == 409


def test_relationship_manager_cannot_draft_or_accept_a_memo():
    for path in (f"/api/deals/{DEAL}/agents/credit-memo/run", f"/api/deals/{DEAL}/memo/accept"):
        resp = client.post(path, json={"acting_user_email": "rm@bank.test"})
        assert resp.status_code == 403
        assert "authority" in resp.json()["detail"]


def test_unknown_user_cannot_run_the_memo_agent():
    resp = client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json={"acting_user_email": "nobody@evil.test"})
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Policy compliance
# ---------------------------------------------------------------------------

def test_policy_run_returns_findings_exceptions_and_the_active_version():
    resp = client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)
    assert resp.status_code == 200
    body = resp.json()
    for field in ("findings", "exceptions", "policy_version"):
        assert field in body
    assert body["policy_version"] == "v4.2"
    assert all("rule_reference" in f for f in body["findings"])
    known = {"PROHIBITED-IND-01", "CONC-LIMIT-01", "LTV-CAP-01", "DSCR-FLOOR-01"}
    assert {f["rule_reference"] for f in body["findings"]} <= known
    assert all(f["status"] in ("passed", "breached", "unevaluated") for f in body["findings"])


def test_the_ltv_and_dscr_breaches_are_raised_with_actual_versus_permitted():
    body = client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST).json()
    breached = {e["rule_reference"]: e for e in body["exceptions"]}
    assert "LTV-CAP-01" in breached
    assert "82.02" in breached["LTV-CAP-01"]["violation_detail"]
    assert "75" in breached["LTV-CAP-01"]["violation_detail"]
    assert "DSCR-FLOOR-01" in breached
    assert "1.24" in breached["DSCR-FLOOR-01"]["violation_detail"]
    for exception in body["exceptions"]:
        assert exception["rationale"].strip()


def test_a_rule_whose_input_is_missing_is_unevaluated_not_passed():
    fresh = _file_deal("No Spread Co", industry="retail", amount=50000)
    body = client.post(f"/api/deals/{fresh}/agents/policy-compliance/run", json=ANALYST).json()
    by_rule = {f["rule_reference"]: f for f in body["findings"]}
    assert by_rule["LTV-CAP-01"]["status"] == "unevaluated"
    assert by_rule["DSCR-FLOOR-01"]["status"] == "unevaluated"
    assert by_rule["PROHIBITED-IND-01"]["status"] == "passed"


def test_a_prohibited_industry_deal_raises_the_prohibited_industry_exception():
    fresh = _file_deal("Bright Star Payday", industry="payday_lending", amount=90000)
    body = client.post(f"/api/deals/{fresh}/agents/policy-compliance/run", json=ANALYST).json()
    breached = {e["rule_reference"]: e for e in body["exceptions"]}
    assert "PROHIBITED-IND-01" in breached
    assert "payday_lending" in breached["PROHIBITED-IND-01"]["violation_detail"]


def test_exceptions_are_recorded_only_after_a_human_accepts_the_review():
    client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)
    before = client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()
    assert all(e["origin"] == "pending_human_review" for e in before["proposed"])

    recorded = client.post(f"/api/deals/{DEAL}/policy-review/accept", json=ANALYST)
    assert recorded.status_code == 200
    body = recorded.json()
    assert body["has_open_exceptions"] is True
    assert body["open_exception_count"] >= 2
    assert body["policy_version"] == "v4.2"

    after = client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()
    refs = {e["rule_reference"] for e in after["recorded"]}
    assert {"LTV-CAP-01", "DSCR-FLOOR-01"} <= refs
    for exception in after["recorded"]:
        assert exception["status"] in ("open", "waived", "upheld")
        assert exception["rationale"]


def test_only_an_officer_may_waive_an_exception_and_a_rationale_is_required():
    client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/policy-review/accept", json=ANALYST)
    listed = client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()["recorded"]
    ref = next(e["exception_ref"] for e in listed if e["status"] == "open")

    denied = client.post(
        f"/api/deals/{DEAL}/policy-exceptions/resolve",
        json={**ANALYST, "decisions": [{"exception_ref": ref, "disposition": "waive", "rationale": "fine by me"}]},
    )
    assert denied.status_code == 403

    blank = client.post(
        f"/api/deals/{DEAL}/policy-exceptions/resolve",
        json={**OFFICER, "decisions": [{"exception_ref": ref, "disposition": "waive", "rationale": "  "}]},
    )
    assert blank.status_code == 400

    waived = client.post(
        f"/api/deals/{DEAL}/policy-exceptions/resolve",
        json={
            **OFFICER,
            "decisions": [
                {
                    "exception_ref": ref,
                    "disposition": "waive",
                    "rationale": "Principal guarantees and 14 years of operating history offset the shortfall.",
                }
            ],
        },
    )
    assert waived.status_code == 200
    assert ref in waived.json()["resolved_exception_ids"]
    current = {e["exception_ref"]: e for e in client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()["recorded"]}
    assert current[ref]["status"] == "waived"
    assert current[ref]["resolved_by_user_id"] is not None


# ---------------------------------------------------------------------------
# The chronicle
# ---------------------------------------------------------------------------

def test_audit_timeline_carries_actor_action_kind_and_timestamp_in_order():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/memo/accept", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)

    resp = client.get(f"/api/deals/{DEAL}/audit", params=AS_ANALYST)
    assert resp.status_code == 200
    body = resp.json()
    entries = body["entries"]
    assert entries
    for entry in entries:
        for field in ("actor_user_id", "action", "agent_draft", "timestamp", "entry_kind"):
            assert field in entry
    assert [e["id"] for e in entries] == sorted(e["id"] for e in entries)

    actions = [e["action"] for e in entries]
    assert "spread.accepted" in actions
    assert "ratios.computed" in actions
    assert "memo.agent_drafted" in actions
    assert "memo.accepted" in actions
    assert "policy.agent_reviewed" in actions

    kinds = {e["action"]: e["entry_kind"] for e in entries}
    assert kinds["memo.agent_drafted"] == "agent_draft"
    assert kinds["memo.accepted"] == "human_decision"
    assert kinds["ratios.computed"] == "calculation"
    assert body["counts"]["all"] == len(entries)
    assert body["append_only"] is True


def test_agent_draft_entries_name_the_agent_that_produced_them():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    entries = client.get(f"/api/deals/{DEAL}/audit", params=AS_ANALYST).json()["entries"]
    drafts = [e for e in entries if e["entry_kind"] == "agent_draft"]
    assert drafts
    assert any(e["agent_draft"] == "Credit Memo Agent" for e in drafts)


def test_timeline_can_be_filtered_by_entry_kind():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    body = client.get(f"/api/deals/{DEAL}/audit", params={**AS_ANALYST, "kind": "agent_draft"}).json()
    assert body["entries"]
    assert all(e["entry_kind"] == "agent_draft" for e in body["entries"])
    assert body["counts"]["all"] > len(body["entries"])


def test_timeline_is_scoped_when_the_caller_identifies_itself():
    other = _file_deal("Someone Elses Deal Co")
    denied = client.get(f"/api/deals/{other}/audit", params={"acting_user_email": "unrelated.rm@bank.test"})
    assert denied.status_code == 403
    allowed = client.get(f"/api/deals/{other}/audit", params={"acting_user_email": "officer@bank.test"})
    assert allowed.status_code == 200


def test_the_audit_trail_has_no_edit_or_delete_path():
    for method in ("PUT", "DELETE", "PATCH"):
        resp = client.request(method, f"/api/deals/{DEAL}/audit")
        assert resp.status_code in (404, 405)


def test_unknown_deal_404s_on_every_surface_of_this_slice():
    assert client.get("/api/deals/DEAL-9999/audit").status_code == 404
    assert client.get("/api/deals/DEAL-9999/policy-exceptions").status_code == 404
    assert client.post("/api/deals/DEAL-9999/agents/credit-memo/run", json=ANALYST).status_code == 404


def test_an_unidentified_read_of_the_memo_is_refused_outright():
    """Negative acceptance: the memo is continuous borrower prose with no
    board-safe projection, so an anonymous read is a 401, not a redaction."""
    anonymous = client.get(f"/api/deals/{DEAL}/memo")
    assert anonymous.status_code == 401
    assert "identify yourself" in anonymous.json()["detail"]
    forged = client.get(f"/api/deals/{DEAL}/memo", params={"acting_user_email": "nobody@evil.test"})
    assert forged.status_code == 403
    named = client.get(f"/api/deals/{DEAL}/memo", headers={"x-user-email": "analyst@bank.test"})
    assert named.status_code == 200


def test_the_chronicle_never_serves_a_raw_audit_payload_body():
    """An audit row's before/after can hold a whole record body. The timeline
    serves a derived, scalar-only summary to EVERY caller, so it can never be
    used as a back door around the endpoints that guard those records."""
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    body = client.get(f"/api/deals/{DEAL}/audit", params=AS_ANALYST).json()
    assert body["entries"]
    for entry in body["entries"]:
        assert "before_payload" not in entry
        assert "after_payload" not in entry
        assert isinstance(entry["summary"], str)
        for payload in (entry["before"], entry["after"]):
            for value in payload.values():
                assert not isinstance(value, dict), "a nested body reached the timeline"
                if isinstance(value, str):
                    assert len(value) <= 121
    # the drafted memo prose itself is nowhere in the timeline
    memo = client.get(f"/api/deals/{DEAL}/memo", params=AS_ANALYST).json()
    prose = (memo["draft"] or memo["accepted"])["memo_content"][:60]
    assert prose not in client.get(f"/api/deals/{DEAL}/audit", params=AS_ANALYST).text


def test_an_unidentified_chronicle_read_is_redacted_not_trusted():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    body = client.get(f"/api/deals/{DEAL}/audit").json()
    assert body["redacted"] is True
    assert body["entries"]
    for entry in body["entries"]:
        assert entry["actor_email"] is None
        assert entry["actor_user_id"] is None
        assert entry["resource_id"] is None
        assert entry["before"] == {} and entry["after"] == {}
    # an identified reader sees the actors and the derived summaries
    named = client.get(f"/api/deals/{DEAL}/audit", params=AS_ANALYST).json()
    assert named["redacted"] is False
    assert any(e["actor_email"] == "analyst@bank.test" for e in named["entries"])


def test_an_unidentified_exception_register_read_withholds_detail_and_rationale():
    client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/policy-review/accept", json=ANALYST)
    anonymous = client.get(f"/api/deals/{DEAL}/policy-exceptions").json()
    assert anonymous["redacted"] is True
    assert anonymous["exceptions"]
    for row in anonymous["exceptions"]:
        assert row["rule_reference"]  # the shape survives
        assert "redacted" in row["rationale"]
        assert "redacted" in row["violation_detail"]
        assert row["raised_by_user_id"] is None
    named = client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()
    assert named["redacted"] is False
    assert any("82.02" in row["violation_detail"] for row in named["exceptions"])
    forged = client.get(f"/api/deals/{DEAL}/policy-exceptions", params={"acting_user_email": "nobody@evil.test"})
    assert forged.status_code == 403


def test_an_exception_cannot_be_disposed_of_twice():
    client.post(f"/api/deals/{DEAL}/agents/policy-compliance/run", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/policy-review/accept", json=ANALYST)
    listed = client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()["recorded"]
    ref = next(e["exception_ref"] for e in listed if e["status"] == "open")
    decision = {
        **OFFICER,
        "decisions": [{"exception_ref": ref, "disposition": "waive", "rationale": "Guarantor pledge covers the gap."}],
    }
    first = client.post(f"/api/deals/{DEAL}/policy-exceptions/resolve", json=decision)
    assert first.status_code == 200
    assert first.json()["dispositions"][0] == {"exception_ref": ref, "from": "open", "to": "waived"}

    second = client.post(f"/api/deals/{DEAL}/policy-exceptions/resolve", json=decision)
    assert second.status_code == 409
    assert "already" in second.json()["detail"]
    # the officer and rationale of record are untouched by the refused attempt
    current = {e["exception_ref"]: e for e in client.get(f"/api/deals/{DEAL}/policy-exceptions", params=AS_ANALYST).json()["recorded"]}
    assert current[ref]["status"] == "waived"
    assert current[ref]["rationale"] == "Guarantor pledge covers the gap."


def test_rejecting_a_memo_draft_requires_a_written_reason():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    blank = client.post(f"/api/deals/{DEAL}/memo/accept", json={**ANALYST, "action": "reject"})
    assert blank.status_code == 400
    whitespace = client.post(f"/api/deals/{DEAL}/memo/accept", json={**ANALYST, "action": "reject", "rejection_reason": "   "})
    assert whitespace.status_code == 400
    given = client.post(
        f"/api/deals/{DEAL}/memo/accept",
        json={**ANALYST, "action": "reject", "rejection_reason": "Ratio section quotes a stale DSCR."},
    )
    assert given.status_code == 200
    assert given.json()["reviewed_by_email"] == "analyst@bank.test"


def test_an_unrecognised_review_action_is_refused_at_the_edge():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    assert client.post(f"/api/deals/{DEAL}/memo/accept", json={**ANALYST, "action": "rubber_stamp"}).status_code == 422
    assert client.post(f"/api/deals/{DEAL}/memo/accept", json={**ANALYST, "action": "accept_with_edits"}).status_code == 400


def test_an_accepted_memo_names_the_human_who_accepted_it():
    client.post(f"/api/deals/{DEAL}/agents/credit-memo/run", json=ANALYST)
    client.post(f"/api/deals/{DEAL}/memo/accept", json=ANALYST)
    accepted = client.get(f"/api/deals/{DEAL}/memo", params=AS_ANALYST).json()["accepted"]
    assert accepted["accepted_by_email"] == "analyst@bank.test"
    assert accepted["accepted_by_role"] == "credit_analyst"
    assert accepted["accepted_at"]


def test_a_fixture_deal_code_is_never_handed_to_a_freshly_filed_deal():
    """The fixture holds DEAL-1003 without consuming the sequence, so the
    sequence must skip it rather than issue it twice."""
    codes = {_file_deal(f"Sequence Probe {n}") for n in range(4)}
    assert FIXTURE_CODE not in codes
    assert len(codes) == 4


def test_workflow_handlers_for_this_slice_are_registered():
    import workflow_engine

    for handler in ("persist_accepted_memo", "record_policy_exceptions", "resolve_policy_exceptions"):
        assert handler in workflow_engine._handlers


# ---------------------------------------------------------------------------

def _file_deal(name, industry="joinery", amount=120000):
    import identity as identity_module

    identity_module.resolve_user("unrelated.rm@bank.test", default_role="relationship_manager")
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": name,
            "borrower_industry": industry,
            "requested_amount": amount,
            "exposure_amount": amount,
            "acting_user_email": "rm@bank.test",
        },
    )
    assert resp.status_code == 201
    return resp.json()["deal_code"]
