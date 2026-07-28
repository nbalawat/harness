"""Slice 3 — AI-drafted risk assessment memo with citations."""
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

# A second, dedicated HIGH-band case for the exploratory/unit tests below, so
# they never draft a memo against ACC-HIGH-001 and disturb the version
# numbering (1, then 2) the slice plan's acceptance replay expects at the end
# of this file.
MEMO_UNIT_PACKAGE = dict(HIGH_PACKAGE, client_reference="ACC-MEMO-UNIT-001", client_name="Solstice Capital Partners")

RETURNED_PACKAGE = {
    "client_reference": "ACC-RETURNED-001",
    "client_name": "Kestrel Nominees SA",
    "entity_type": "corporate",
    "submitted_by": "ana.analyst",
    "documents": ["certificate_of_incorporation", "proof_of_registered_address"],
    "attributes": {"ownership_chain_depth": 3, "regulated_industry": True, "cross_border_expected": False},
    "risk_factors": {
        "jurisdiction": "fatf_high_risk",
        "entity_structure": "chain_depth_over_3",
        "industry": "money_services",
        "sanctions_screening": "clear",
        "expected_activity": "domestic_only",
    },
}


def ensure_case(reference, package):
    if client.get("/cases/" + reference).status_code != 200:
        client.post("/cases", json=package)


def ensure_high_case():
    """Slice 2's own tests already create ACC-HIGH-001 in a shared process —
    this just makes the file runnable on its own too. Nothing in this file
    ever drafts a memo against it except the acceptance replay at the end."""
    ensure_case("ACC-HIGH-001", HIGH_PACKAGE)


def test_policy_corpus_is_published_and_versioned():
    body = client.get("/policy-corpus").json()
    ids = {d["id"] for d in body["documents"]}
    assert {"kyc-onboarding-policy", "document-checklist", "escalation-sla-policy", "risk-rating-matrix"} <= ids
    for doc in body["documents"]:
        assert doc["version"]


def test_citation_resolves_a_named_provision():
    body = client.get(
        "/citations/resolve", params={"document": "risk-rating-matrix", "section": "jurisdiction"}
    ).json()
    assert body["document"] == "risk-rating-matrix"
    assert body["weight"] == 0.3
    assert body["resolved"] is True


def test_citation_resolve_reports_unknown_sections_honestly():
    body = client.get(
        "/citations/resolve", params={"document": "risk-rating-matrix", "section": "not-a-thing"}
    ).json()
    assert body["resolved"] is False


def test_citation_resolutions_used_in_a_memo_are_themselves_re_resolvable():
    """A citation the memo stores must resolve again the same way an auditor's
    own GET /citations/resolve call would — never a one-shot lookup."""
    ensure_case("ACC-MEMO-UNIT-001", MEMO_UNIT_PACKAGE)
    body = client.post(
        "/memos/draft", json={"case_reference": "ACC-MEMO-UNIT-001", "requested_by": "ana.analyst"}
    ).json()
    assert body["citations_resolved"] is True
    for citation in body["policy_citations"]:
        again = client.get(
            "/citations/resolve", params={"document": citation["document"], "section": citation["section"]}
        ).json()
        assert again["resolved"] is True


def test_memo_draft_refuses_a_case_that_has_not_been_scored():
    """A RETURNED case never reached scoring — nothing for the agent to assess."""
    ensure_case("ACC-RETURNED-001", RETURNED_PACKAGE)
    response = client.post("/memos/draft", json={"case_reference": "ACC-RETURNED-001", "requested_by": "ana.analyst"})
    assert response.status_code == 400


def test_memo_draft_refuses_unknown_reference():
    response = client.post("/memos/draft", json={"case_reference": "NOPE-999", "requested_by": "ana.analyst"})
    assert response.status_code == 404


def test_memo_draft_is_machine_drafted_grounded_and_cited():
    ensure_case("ACC-MEMO-UNIT-001", MEMO_UNIT_PACKAGE)
    response = client.post(
        "/memos/draft", json={"case_reference": "ACC-MEMO-UNIT-001", "requested_by": "ana.analyst"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["is_machine_drafted"] is True
    assert body["version"] >= 1
    assert "machine-drafted" in body["memo_text"].lower()
    assert "requires human approval" in body["memo_text"].lower()
    assert "beneficial ownership" in body["memo_text"].lower()
    assert "jurisdiction" in body["memo_text"].lower()
    assert "sanctions" in body["memo_text"].lower()
    # the score/band in the memo must match the case record exactly, never a recomputation
    case = client.get("/cases/ACC-MEMO-UNIT-001").json()
    assert str(case["total_risk_score"]) in body["memo_text"]
    assert case["risk_band"] in body["memo_text"].lower()
    assert len(body["policy_citations"]) >= 3
    assert body["citations_resolved"] is True
    # never any first-person claim of a decision the agent is denied from making
    for phrase in ("i have approved", "i have rejected", "status updated to", "score adjusted"):
        assert phrase not in body["memo_text"].lower()


def test_memo_agent_never_alters_the_case_it_drafted_for():
    ensure_case("ACC-MEMO-UNIT-001", MEMO_UNIT_PACKAGE)
    before = client.get("/cases/ACC-MEMO-UNIT-001").json()
    client.post("/memos/draft", json={"case_reference": "ACC-MEMO-UNIT-001", "requested_by": "ana.analyst"})
    after = client.get("/cases/ACC-MEMO-UNIT-001").json()
    assert after["status"] == before["status"]
    assert after["total_risk_score"] == before["total_risk_score"]
    assert after["risk_band"] == before["risk_band"]


def test_every_redraft_is_a_new_immutable_version():
    ensure_case("ACC-MEMO-UNIT-001", MEMO_UNIT_PACKAGE)
    first = client.post(
        "/memos/draft", json={"case_reference": "ACC-MEMO-UNIT-001", "requested_by": "ana.analyst"}
    ).json()
    second = client.post(
        "/memos/draft", json={"case_reference": "ACC-MEMO-UNIT-001", "requested_by": "ana.analyst"}
    ).json()
    assert second["version"] == first["version"] + 1
    listing = client.get("/cases/ACC-MEMO-UNIT-001/memos").json()
    versions = [m["version"] for m in listing["memos"]]
    assert first["version"] in versions and second["version"] in versions
    # the earlier version's text is retained verbatim, never overwritten
    earlier = next(m for m in listing["memos"] if m["version"] == first["version"])
    assert earlier["memo_text"] == first["memo_text"]


def test_agents_roster_discloses_the_memo_assistant_and_its_guardrails():
    body = client.get("/agents").json()
    agent = body["agents"][0]
    assert "memo" in agent["name"].lower()
    assert "save_memo_draft" in agent["tools"]
    assert "update_case_status" in agent["denied_tools"]
    assert "record_approval_or_rejection" in agent["denied_tools"]


def test_workflow_definitions_still_validate():
    import workflow_engine

    assert workflow_engine.validate_definitions() == []


# --------------------------------------------------------------------------
# The slice plan's acceptance checks, replayed verbatim. The verifier asserts
# exactly these (status + substring containment on the raw response text), so
# a regression should fail here rather than costing a full boot cycle.
#
# ACC-HIGH-001 is untouched by every other test in this file, so its very
# first two /memos/draft calls here land as version 1 then version 2, exactly
# as the slice plan expects.
# --------------------------------------------------------------------------
def test_slice_plan_acceptance_checks_pass_in_order():
    ensure_high_case()

    response = client.get("/policy-corpus")
    assert response.status_code == 200
    for needle in [
        "kyc-onboarding-policy",
        "document-checklist",
        "escalation-sla-policy",
        "risk-rating-matrix",
        "version",
    ]:
        assert needle in response.text

    response = client.post("/memos/draft", json={"case_reference": "ACC-HIGH-001", "requested_by": "ana.analyst"})
    assert response.status_code == 200
    assert '"version":1' in response.text
    for needle in ["machine-drafted", '"is_machine_drafted":true', "policy_citations", "memo_text"]:
        assert needle in response.text.lower() or needle in response.text

    response = client.post("/memos/draft", json={"case_reference": "ACC-HIGH-001", "requested_by": "ana.analyst"})
    assert response.status_code == 200
    assert '"version":2' in response.text
    assert '"is_machine_drafted":true' in response.text

    response = client.get("/cases/ACC-HIGH-001/memos")
    assert response.status_code == 200
    for needle in ['"version":1', '"version":2', "policy_citations"]:
        assert needle in response.text
    assert "machine-drafted" in response.text.lower()

    response = client.get("/cases/ACC-HIGH-001")
    assert response.status_code == 200
    assert '"status":"ready"' in response.text
    assert '"risk_band":"high"' in response.text

    response = client.get("/citations/resolve", params={"document": "risk-rating-matrix", "section": "jurisdiction"})
    assert response.status_code == 200
    for needle in ["risk-rating-matrix", "jurisdiction", "0.3"]:
        assert needle in response.text

    response = client.get("/agents")
    assert response.status_code == 200
    for needle in ["save_memo_draft", "denied_tools", "record_approval_or_rejection", "update_case_status"]:
        assert needle in response.text
    assert "risk assessment memo assistant" in response.text.lower()
