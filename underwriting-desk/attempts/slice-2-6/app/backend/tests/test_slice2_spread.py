"""Slice 2 — financial spreading agent + the Draft Review workspace.

Same style as slice 1: stub agent mode pinned, TestClient over the composed
app. The rules under test are the ones a regulator would ask about: a figure
never reaches the deal of record without a citation the stored document
actually supports, only a named human promotes a draft, and no ratio is
produced anywhere in this path.
"""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import spreading  # noqa: E402
import underwriting as uw  # noqa: E402
import workflow_engine  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

FINANCIALS = (
    "FY2025 Audited Financial Statements - Piedmont Orthopedic Devices LLC. "
    "Income Statement: Revenue 12,400,000; Cost of Goods Sold 7,300,000; Operating Expenses 3,680,000; "
    "EBITDA 1,420,000; Interest Expense 310,000. "
    "Balance Sheet: Current Assets 3,300,000; Current Liabilities 1,650,000; Total Debt 5,600,000; "
    "Tangible Net Worth 2,800,000. Debt Service: Annual Principal and Interest 1,000,000."
)
TAX_RETURN = (
    "Form 1120S tax year 2025 - Piedmont Orthopedic Devices LLC. Gross receipts 12,400,000. "
    "Ordinary business income 1,110,000. Depreciation 620,000."
)

SUBMISSION = {
    "borrower_name": "Piedmont Orthopedic Devices LLC",
    "borrower_industry": "surgical instrument manufacturing",
    "borrower_state": "North Carolina",
    "facility_type": "term_loan",
    "requested_amount": 780000,
    "collateral_value": 1100000,
    "purpose": "CNC line expansion and refinance",
    "submitted_by": "rm.rivera",
    "documents": [
        {
            "document_type": "financial_statements",
            "original_filename": "2025-FYE-Financials.pdf",
            "content_type": "application/pdf",
            "text": FINANCIALS,
        },
        {
            "document_type": "business_tax_return",
            "original_filename": "1120S-2025.pdf",
            "content_type": "application/pdf",
            "text": TAX_RETURN,
        },
    ],
}


def _submit(reference, overrides=None):
    body = dict(SUBMISSION)
    body.update(overrides or {})
    body["deal_reference"] = reference
    response = client.post("/deals", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _accept_triage(reference, actor="an.chen"):
    return client.post(f"/deals/{reference}/drafts/triage/review", json={"action": "accepted", "acting_user": actor})


def _spread(reference, actor="an.chen"):
    return client.post(f"/deals/{reference}/spread", json={"acting_user": actor})


def _review_spread(reference, action, actor="an.chen", **extra):
    body = {"action": action, "acting_user": actor}
    body.update(extra)
    return client.post(f"/deals/{reference}/drafts/spread/review", json=body)


def _ready(reference, overrides=None):
    """A deal sitting at document_extraction with an accepted triage draft."""
    _submit(reference, overrides)
    assert _accept_triage(reference).status_code == 200
    return uw.require_deal(reference)


# ---------------------------------------------------------------- deterministic units


@pytest.mark.parametrize(
    "raw,expected",
    [("12,400,000", 12400000.0), ("$1,420,000", 1420000.0), ("(310,000)", -310000.0), ("7,300,000;", 7300000.0), ("n/a", None)],
)
def test_amount_parsing_is_deterministic(raw, expected):
    assert spreading.parse_amount(raw) == expected


@pytest.mark.parametrize(
    "key,text,expected",
    [
        ("revenue", "Income Statement: Revenue 12,400,000;", 12400000.0),
        ("revenue", "Gross receipts 12,400,000.", 12400000.0),
        ("ebitda", "EBITDA 1,420,000;", 1420000.0),
        ("total_debt", "Total Debt 5,600,000;", 5600000.0),
        # the debt-service line is not the funded-debt balance
        ("total_debt", "Total Debt Service 1,000,000.", None),
        ("annual_debt_service", "Annual Principal and Interest 1,000,000.", 1000000.0),
        ("current_liabilities", "Current Assets 3,300,000;", None),
        ("net_income", "Ordinary business income 1,110,000.", None),
    ],
)
def test_template_line_extraction(key, text, expected):
    assert spreading.find_line_value(spreading.TEMPLATE_BY_KEY[key], text) == expected


def test_template_carries_no_derived_or_computed_line():
    # REQ-009: DSCR, leverage and the current ratio are computed by code from
    # the accepted spread — the spread template itself must not contain them.
    assert not {"dscr", "leverage", "current_ratio", "risk_grade"} & set(spreading.TEMPLATE_KEYS)


def test_derive_spread_cites_every_figure_it_produces():
    deal = _ready("T-SPREAD-DERIVE")
    items = spreading.derive_spread(spreading.spread_facts(deal))
    assert [item["line_item_key"] for item in items] == list(spreading.TEMPLATE_KEYS)
    for item in items:
        if item["value"] is None:
            assert item["note"] == spreading.NOT_SUPPORTED
            assert item["citation"] is None
        else:
            citation = item["citation"]
            assert citation["document_id"] and citation["document_location_id"]
            # the citation must resolve to text that actually states the figure
            location = next(loc for loc in uw.store.list("document_locations") if loc["id"] == citation["document_location_id"])
            assert spreading._digits(item["value_display"]) in spreading._digits(location["extracted_text"])
    by_key = {item["line_item_key"]: item for item in items}
    assert by_key["ebitda"]["value"] == 1420000.0
    assert by_key["annual_debt_service"]["value"] == 1000000.0
    assert by_key["net_income"]["value"] is None


def test_agent_reply_is_rejected_when_its_citation_is_not_verifiable():
    deal = _ready("T-SPREAD-PARSE")
    facts = spreading.spread_facts(deal)
    location = facts["ordered_locations"][0]
    good_ids = {"document_id": location["document_id"], "document_location_id": location["id"]}

    def reply(items):
        import json

        return json.dumps({"line_items": items})

    # a figure that the cited location does not state
    fabricated = [
        dict({"line_item_key": key, "value": None, "note": spreading.NOT_SUPPORTED}, **{"document_id": None, "document_location_id": None})
        for key in spreading.TEMPLATE_KEYS
    ]
    fabricated[0] = dict({"line_item_key": "revenue", "value": 99_000_000}, **good_ids)
    assert spreading.parse_spread_reply(reply(fabricated), facts) is None

    # a figure whose digits appear in the cited text but which that text does
    # not state for this template line ("12,400,000" contains "400,000", and a
    # revenue location says nothing about EBITDA)
    revenue_location = next(
        loc for loc in facts["ordered_locations"] if "Revenue 12,400,000" in str(loc.get("extracted_text"))
    )
    revenue_ids = {"document_id": revenue_location["document_id"], "document_location_id": revenue_location["id"]}
    wrong_line = list(fabricated)
    wrong_line[0] = {"line_item_key": "revenue", "value": None, "note": spreading.NOT_SUPPORTED}
    wrong_line[3] = dict({"line_item_key": "ebitda", "value": 400000}, **revenue_ids)
    assert spreading.parse_spread_reply(reply(wrong_line), facts) is None

    # a citation to a location that belongs to another deal / does not exist
    unknown = list(fabricated)
    unknown[0] = {"line_item_key": "revenue", "value": 12400000, "document_id": 999999, "document_location_id": 999998}
    assert spreading.parse_spread_reply(reply(unknown), facts) is None

    # a line item outside the standard template
    off_template = list(fabricated)
    off_template[0] = {"line_item_key": "goodwill", "value": None, "note": spreading.NOT_SUPPORTED}
    assert spreading.parse_spread_reply(reply(off_template), facts) is None


def test_agent_reply_is_accepted_when_every_figure_verifies():
    import json

    deal = _ready("T-SPREAD-PARSE-OK")
    facts = spreading.spread_facts(deal)
    revenue_location = next(
        loc for loc in facts["ordered_locations"] if "Revenue 12,400,000" in str(loc.get("extracted_text"))
    )
    items = [
        {"line_item_key": key, "value": None, "note": spreading.NOT_SUPPORTED, "document_id": None, "document_location_id": None}
        for key in spreading.TEMPLATE_KEYS
    ]
    items[0] = {
        "line_item_key": "revenue",
        "value": 12400000,
        "period": "FY2025",
        "document_id": revenue_location["document_id"],
        "document_location_id": revenue_location["id"],
    }
    parsed = spreading.parse_spread_reply(json.dumps({"line_items": items}), facts)
    assert parsed is not None
    assert parsed[0]["value"] == 12400000.0
    assert parsed[0]["citation"]["document_location_id"] == revenue_location["id"]


# ---------------------------------------------------------------- the spreading endpoint


def test_spread_draft_is_pending_and_writes_nothing_to_the_record():
    reference = "T-SPREAD-PENDING"
    _ready(reference)
    body = _spread(reference).json()
    assert body["review_status"] == "pending"
    assert body["draft_type"] == "spread"
    assert len(body["spread_line_items"]) == len(spreading.TEMPLATE_KEYS)
    assert body["citations"], "the spread must cite the documents it read"
    assert body["uncited_figure_count"] == 0
    deal = uw.require_deal(reference)
    # PENDING means pending: no spread line item exists until a human accepts.
    assert spreading.spread_of_record(deal["id"])["spread_line_items"] == []
    # the agent may not advance the deal past its own working stage
    assert deal["current_stage"] == "financial_spreading"


def test_spread_run_is_idempotent_while_a_draft_is_pending():
    reference = "T-SPREAD-IDEMPOTENT"
    _ready(reference)
    first = _spread(reference).json()
    second = _spread(reference).json()
    assert first["id"] == second["id"]
    assert second["created"] is False


def test_spread_requires_an_accepted_triage_first():
    reference = "T-SPREAD-EARLY"
    _submit(reference)
    response = _spread(reference)
    assert response.status_code == 409
    assert "triage" in response.json()["detail"]


def test_spread_is_denied_to_roles_without_the_grant():
    reference = "T-SPREAD-RBAC"
    _ready(reference)
    response = _spread(reference, actor="rm.rivera")
    assert response.status_code == 403
    unknown = _spread(reference, actor="not.a.user")
    assert unknown.status_code == 403


def test_spread_run_records_agent_telemetry():
    reference = "T-SPREAD-TELEMETRY"
    _ready(reference)
    body = _spread(reference).json()
    run = body["agent_run"]
    assert run["model_id"] and run["prompt_template_version"].startswith("financial_spread@")
    assert run["token_cost"] is not None
    assert run["tokens_in_estimated"] and run["tokens_out_estimated"]
    stored = [r for r in uw.store.list("agent_runs") if r["id"] == run["id"]][0]
    assert stored["inputs"]["template_version"] == spreading.SPREAD_TEMPLATE_VERSION
    assert stored["raw_output"] is not None


# ---------------------------------------------------------------- the human gate


def test_rejection_requires_a_written_reason_and_keeps_the_record_empty():
    reference = "T-SPREAD-REJECT"
    _ready(reference)
    _spread(reference)
    refused = _review_spread(reference, "rejected")
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]

    rejected = _review_spread(reference, "rejected", reason="EBITDA line reads the prior year; re-draft against FY2025.")
    assert rejected.status_code == 200
    deal = uw.require_deal(reference)
    assert spreading.spread_of_record(deal["id"])["spread_line_items"] == []
    assert deal["current_stage"] == "financial_spreading"
    audit = [row for row in uw.store.list("audit_log") if row.get("deal_reference") == reference]
    assert any(row["event_type"] == "agent_draft.rejected" and row["details"].get("reason") for row in audit)

    # A re-draft is a NEW agent call informed by the reviewer's reason — never
    # a replay of the workflow reply the reviewer just rejected.
    rejected_run = uw.drafts_for(deal["id"], "spread")[-1]["agent_run_id"]
    redraft = _spread(reference).json()
    assert redraft["review_status"] == "pending"
    assert redraft["agent_run_id"] != rejected_run
    assert spreading.rejection_feedback(deal).find("EBITDA line reads the prior year") > 0
    fresh_run = [r for r in uw.store.list("agent_runs") if r["id"] == redraft["agent_run_id"]][0]
    assert fresh_run["latency_ms"] is not None, "a re-draft is a measured agent call, not an adopted reply"


def test_the_deal_submitter_may_not_disposition_its_drafts():
    reference = "T-SPREAD-SOD"
    _ready(reference, {"submitted_by": "co.brennan"})
    _spread(reference)
    response = _review_spread(reference, "accepted", actor="co.brennan")
    assert response.status_code == 403
    assert "segregation of duties" in response.json()["detail"]


def test_acceptance_persists_line_items_with_citations_and_advances_the_stage():
    reference = "T-SPREAD-ACCEPT"
    _ready(reference)
    _spread(reference)
    body = _review_spread(reference, "accepted").json()
    assert body["review_action"] == "accepted"
    assert body["current_stage"] == "risk_grading"
    promoted = body["promoted"]
    assert len(promoted["spread_line_item_ids"]) == len(spreading.TEMPLATE_KEYS)
    assert promoted["citation_ids"]

    deal = uw.require_deal(reference)
    record = spreading.spread_of_record(deal["id"])
    by_key = {row["line_item_key"]: row for row in record["spread_line_items"]}
    assert by_key["ebitda"]["value"] == 1420000.0
    assert by_key["ebitda"]["accepted_by_user_id"] == "an.chen"
    assert by_key["net_income"]["value"] is None
    assert by_key["net_income"]["note"] == spreading.NOT_SUPPORTED
    # every figure on the record carries a citation to a document location
    cited = {row["spread_line_item_id"] for row in record["citations"]}
    for row in record["spread_line_items"]:
        assert (row["value"] is None) == (row["id"] not in cited)
    for citation in record["citations"]:
        assert citation["document_id"] and citation["document_location_id"]
    assert any(row["event_type"] == "spread.persisted" for row in uw.store.list("audit_log") if row.get("deal_reference") == reference)


def test_acceptance_is_replay_safe():
    reference = "T-SPREAD-REPLAY"
    _ready(reference)
    _spread(reference)
    first = _review_spread(reference, "accepted").json()["promoted"]["spread_line_item_ids"]
    deal = uw.require_deal(reference)
    again = spreading.promote_spread(deal, {"spread_line_items": []}, {"username": "an.chen"})
    assert again["already_persisted"] is True
    assert again["spread_line_item_ids"] == first


def test_a_reviewer_correction_replaces_the_agent_citation_with_its_own_provenance():
    reference = "T-SPREAD-EDIT"
    _ready(reference)
    _spread(reference)
    response = _review_spread(
        reference,
        "edited",
        edits={"line_items": {"ebitda": 1_395_000}},
        reason="Statement EBITDA includes a one-off insurance recovery; normalised to 1,395,000.",
    )
    assert response.status_code == 200, response.text
    draft = response.json()["draft"]
    assert draft["human_edits"]["ebitda"] == {"from": 1420000.0, "to": 1395000.0}
    deal = uw.require_deal(reference)
    record = spreading.spread_of_record(deal["id"])
    ebitda = next(row for row in record["spread_line_items"] if row["line_item_key"] == "ebitda")
    assert ebitda["value"] == 1395000.0
    assert ebitda["evidence_status"] == "human_corrected"
    citation = next(row for row in record["citations"] if row["spread_line_item_id"] == ebitda["id"])
    assert citation["source_type"] == "human_correction"
    assert "an.chen" in citation["source_reference"]


def test_an_edit_off_the_template_or_not_a_number_is_refused():
    reference = "T-SPREAD-EDIT-BAD"
    _ready(reference)
    _spread(reference)
    why = "reviewer correction"
    assert _review_spread(reference, "edited", edits={"line_items": {"goodwill": 10}}, reason=why).status_code == 400
    assert _review_spread(reference, "edited", edits={"line_items": {"ebitda": "lots"}}, reason=why).status_code == 400
    assert _review_spread(reference, "edited", edits={}, reason=why).status_code == 400
    # still pending: a refused edit dispositions nothing
    deal = uw.require_deal(reference)
    assert uw.pending_draft(deal["id"], "spread") is not None


def test_correcting_a_figure_requires_a_written_reason():
    reference = "T-SPREAD-EDIT-REASON"
    _ready(reference)
    _spread(reference)
    refused = _review_spread(reference, "edited", edits={"line_items": {"ebitda": 1_000_000}})
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]
    deal = uw.require_deal(reference)
    draft = uw.pending_draft(deal["id"], "spread")
    ebitda = next(i for i in draft["draft_content"]["spread_line_items"] if i["line_item_key"] == "ebitda")
    assert ebitda["value"] == 1420000.0, "a refused edit must not leave a human change on the draft"


def test_a_partly_invalid_edit_batch_leaves_the_draft_exactly_as_the_agent_produced_it():
    reference = "T-SPREAD-EDIT-ATOMIC"
    _ready(reference)
    _spread(reference)
    refused = _review_spread(
        reference,
        "edited",
        edits={"line_items": {"ebitda": 1_395_000, "goodwill": 5}},
        reason="normalising EBITDA",
    )
    assert refused.status_code == 400
    deal = uw.require_deal(reference)
    draft = uw.pending_draft(deal["id"], "spread")
    assert draft is not None
    ebitda = next(i for i in draft["draft_content"]["spread_line_items"] if i["line_item_key"] == "ebitda")
    assert ebitda["value"] == 1420000.0
    assert ebitda["evidence_status"] == "cited"
    assert ebitda["citation"]["source_type"] == "document_location"
    assert draft["human_edits"] is None


def test_an_uncited_figure_may_not_reach_the_deal_of_record():
    reference = "T-SPREAD-UNCITED"
    deal = _ready(reference)
    doctored = {"spread_line_items": [{"line_item_key": "ebitda", "value": 1_000_000.0, "citation": None}]}
    with pytest.raises(uw.DomainError) as exc:
        spreading.promote_spread(deal, doctored, {"username": "an.chen"})
    assert exc.value.status == 422
    assert spreading.spread_of_record(deal["id"])["spread_line_items"] == []


# ---------------------------------------------------------------- workflow contract


def test_persist_spread_handler_meets_its_node_contract_and_is_idempotent():
    reference = "T-SPREAD-WORKFLOW"
    _ready(reference)
    _spread(reference)
    assert _review_spread(reference, "accepted").status_code == 200
    deal = uw.require_deal(reference)
    required = next(
        node["output_schema"]["required"]
        for workflow in workflow_engine.definitions()
        if workflow["name"] == "deal-underwriting"
        for node in workflow["nodes"]
        if node["id"] == "persist_spread"
    )
    output = spreading.handler_persist_spread_line_items({"register_deal": {"deal_id": reference}})
    assert set(required) <= set(output)
    assert output["reviewed_by_user_id"] == "an.chen"
    assert len(output["spread_line_item_ids"]) == len(spreading.TEMPLATE_KEYS)
    assert workflow_engine._handlers["persist_spread_line_items"] is spreading.handler_persist_spread_line_items


def test_the_run_parks_instead_of_failing_on_nodes_a_later_slice_delivers():
    reference = "T-SPREAD-PARKED"
    _ready(reference)
    _spread(reference)
    assert _review_spread(reference, "accepted").status_code == 200
    deal = uw.require_deal(reference)
    state = workflow_engine.state(deal["workflow_run_id"])
    # the human decision is recorded; the run waits rather than dying on a
    # handler no shipped slice registers yet
    assert state["status"] != "failed"
    assert "compute_financial_ratios" in uw.pending_handler_gaps(deal["workflow_run_id"])


# ---------------------------------------------------------------- review workspace API


def test_review_queue_serves_every_artifact_with_its_run_telemetry():
    reference = "T-SPREAD-QUEUE"
    _ready(reference)
    _spread(reference)
    payload = client.get("/drafts").json()
    mine = [row for row in payload["drafts"] if row["deal_reference"] == reference]
    assert {row["draft_type"] for row in mine} == {"triage", "spread"}
    spread_row = next(row for row in mine if row["draft_type"] == "spread")
    assert spread_row["artifact_label"] == "Financial spread"
    assert spread_row["agent_label"].startswith("2 ")
    assert spread_row["model_id"]
    assert payload["counts"]["pending"] >= 1

    only_spreads = client.get("/drafts?draft_type=spread").json()["drafts"]
    assert all(row["draft_type"] == "spread" for row in only_spreads)


def test_draft_detail_pairs_each_figure_with_the_stored_document_text():
    reference = "T-SPREAD-DETAIL"
    _ready(reference)
    draft_id = _spread(reference).json()["id"]
    detail = client.get(f"/drafts/{draft_id}").json()
    assert detail["draft"]["draft_type"] == "spread"
    assert detail["gate"]["pending"] is True
    assert detail["gate"]["barred_reviewer"] == "rm.rivera"
    assert detail["deal"]["deal_reference"] == reference
    assert detail["evidence"]
    for item in detail["evidence"]:
        assert item["verified"] is True
        assert item["excerpt"]
        assert spreading._digits(item["cited_value"]) in spreading._digits(item["excerpt"])
    assert client.get("/drafts/999999").status_code == 404


def test_spread_of_record_endpoint_reads_the_accepted_spread():
    reference = "T-SPREAD-RECORD"
    _ready(reference)
    _spread(reference)
    before = client.get(f"/deals/{reference}/spread").json()
    assert before["accepted"] is False
    assert before["spread_line_items"] == []
    _review_spread(reference, "accepted")
    after = client.get(f"/deals/{reference}/spread").json()
    assert after["accepted"] is True
    assert len(after["spread_line_items"]) == len(spreading.TEMPLATE_KEYS)
    assert after["citations"]


def test_a_relationship_manager_sees_only_their_own_deals_in_the_review_queue():
    reference = "T-SPREAD-SCOPE"
    _ready(reference, {"submitted_by": "co.brennan"})
    _spread(reference)
    token = client.post("/auth/login", json={"username": "rm.rivera"}).json()["token"]
    scoped = client.get("/drafts", headers={"Authorization": f"Bearer {token}"}).json()
    assert all(row["deal_reference"] != reference for row in scoped["drafts"])
    draft_id = uw.pending_draft(uw.require_deal(reference)["id"], "spread")["id"]
    assert client.get(f"/drafts/{draft_id}", headers={"Authorization": f"Bearer {token}"}).status_code == 404
    assert client.post(f"/deals/{reference}/spread", json={}, headers={"Authorization": f"Bearer {token}"}).status_code == 404


# ---------------------------------------------------------------- hardening


@pytest.mark.parametrize("table", ["spread_line_items", "citations"])
def test_the_generic_table_api_cannot_write_the_spread_of_record(table):
    response = client.post(f"/api/{table}", json={"deal_id": 1, "value": 1})
    assert response.status_code == 403
    assert "guarded endpoint" in response.json()["detail"] or "deal of record" in response.json()["detail"]


def test_document_text_is_not_dumped_through_the_generic_reader():
    rows = client.get("/api/document_locations").json()
    assert rows and all("extracted_text" not in row for row in rows)


def test_the_draft_copy_of_borrower_document_text_is_scrubbed_from_generic_reads_and_exports():
    reference = "T-SPREAD-LEAK"
    _ready(reference)
    _spread(reference)
    excerpt = "Revenue 12,400,000"
    drafts = client.get("/api/agent_drafts").json()
    assert drafts and all("draft_content" not in row for row in drafts)
    assert excerpt not in client.get("/api/agent_drafts").text
    assert excerpt not in client.get("/api/agent_runs").text
    assert excerpt not in client.get("/export/agent_drafts.csv").text
    assert excerpt not in client.get("/export/document_locations.csv").text


def test_a_rejection_is_recorded_against_the_process_rather_than_left_parked():
    # A deferred rejection would leave the run parked on a decided item that a
    # later slice's first tick would resolve as a failure — long after a
    # re-draft had been accepted. Rejections reach the engine immediately.
    reference = "T-SPREAD-REJECT-RUN"
    _ready(reference)
    _spread(reference)
    deal = uw.require_deal(reference)
    assert _review_spread(reference, "rejected", reason="Spread cites the wrong statement year.").status_code == 200
    assert uw.pending_handler_gaps(deal["workflow_run_id"]) == []
    state = workflow_engine.state(deal["workflow_run_id"])
    assert state["status"] == "failed" and "spread_review" in str(state.get("error"))
    # and the deal is still workable: a re-draft opens its own human gate
    redraft = _spread(reference).json()
    assert redraft["review_status"] == "pending"
    assert _review_spread(reference, "accepted").status_code == 200
    assert uw.require_deal(reference)["current_stage"] == "risk_grading"
