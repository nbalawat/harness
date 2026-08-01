"""Slice 2 — financial spreading agent + the Draft Review workspace.

Same style as the generated harness: stub agent mode pinned, TestClient over
the composed app. Money is deterministic here by contract, so the extractor,
the citation binding and the agent-proposal validator all get unit coverage
alongside the end-to-end gate.
"""
import json
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
    "FY2025 Audited Financial Statements - Ridgeline Composites LLC. "
    "Income Statement: Revenue 12,400,000; Cost of Goods Sold 7,300,000; "
    "Operating Expenses 3,680,000; EBITDA 1,420,000; Interest Expense 310,000. "
    "Balance Sheet: Current Assets 3,300,000; Current Liabilities 1,650,000; "
    "Total Debt 5,600,000; Tangible Net Worth 2,800,000. "
    "Debt Service: Annual Principal and Interest 1,000,000."
)
TAX_RETURN = (
    "Form 1120S tax year 2025 - Ridgeline Composites LLC. Gross receipts 12,400,000. "
    "Ordinary business income 1,110,000. Depreciation 620,000."
)

EXPECTED = {
    "revenue": 12_400_000,
    "cost_of_goods_sold": 7_300_000,
    "operating_expenses": 3_680_000,
    "ebitda": 1_420_000,
    "depreciation_amortization": 620_000,
    "interest_expense": 310_000,
    "net_income": 1_110_000,
    "current_assets": 3_300_000,
    "current_liabilities": 1_650_000,
    "total_debt": 5_600_000,
    "tangible_net_worth": 2_800_000,
    "annual_debt_service": 1_000_000,
}
UNSUPPORTED = {"gross_profit", "owner_distributions"}


def _submit(reference, documents=None):
    body = {
        "deal_reference": reference,
        "borrower_name": "Ridgeline Composites LLC",
        "borrower_industry": "aerospace composites manufacturing",
        "borrower_state": "North Carolina",
        "facility_type": "term_loan",
        "requested_amount": 820000,
        "collateral_value": 1150000,
        "purpose": "autoclave line expansion",
        "submitted_by": "rm.rivera",
        "documents": documents
        if documents is not None
        else [
            {
                "document_type": "financial_statements",
                "original_filename": "FYE-2025.pdf",
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
    response = client.post("/deals", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _accept_triage(reference, actor="an.chen"):
    response = client.post(
        f"/deals/{reference}/drafts/triage/review", json={"action": "accepted", "acting_user": actor}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _spread(reference, actor="an.chen"):
    return client.post(f"/deals/{reference}/spread", json={"acting_user": actor})


# ---------------------------------------------------------------- deterministic units


@pytest.mark.parametrize(
    "token,expected",
    [
        ("12,400,000", 12_400_000.0),
        ("$1,420,000", 1_420_000.0),
        ("(55,051)", -55_051.0),
        ("1234.50", 1234.5),
        ("not supported by the record", None),
        ("", None),
        ("-", None),
    ],
)
def test_parse_number(token, expected):
    assert spreading.parse_number(token) == expected


def test_parse_number_rejects_absurd_magnitude():
    assert spreading.parse_number("9" * 40) is None


def test_value_supported_by_matches_the_stated_figure_only():
    text = "EBITDA 1,420,000;"
    assert spreading.value_supported_by(text, 1_420_000)
    assert not spreading.value_supported_by(text, 1_420_001)


def test_period_detection():
    assert spreading.period_of(["FY2025 Audited Financial Statements."]) == "FY2025"
    assert spreading.period_of(["Form 1120S tax year 2025 - Acme."]) == "FY2025"
    assert spreading.period_of(["no period stated here"]) is None


def test_single_word_caption_is_never_harvested_out_of_a_longer_caption():
    """'Sales' must not be read out of 'Cost of Sales' — that would silently
    put the wrong number on the revenue line of a credit file."""
    locations = [{"id": 1, "document_id": 1, "page_number": 1, "section": "IS", "extracted_text": "Cost of Sales 7,300,000;"}]
    revenue = spreading.TEMPLATE_BY_KEY["revenue"]
    assert spreading.find_line_value(revenue, locations) is None
    cogs = spreading.TEMPLATE_BY_KEY["cost_of_goods_sold"]
    assert spreading.find_line_value(cogs, locations)["value"] == 7_300_000


def test_interest_expense_is_not_read_from_the_debt_service_line():
    locations = [
        {"id": 9, "document_id": 1, "page_number": 2, "section": "DS", "extracted_text": "Annual Principal and Interest 1,000,000."}
    ]
    assert spreading.find_line_value(spreading.TEMPLATE_BY_KEY["interest_expense"], locations) is None
    assert spreading.find_line_value(spreading.TEMPLATE_BY_KEY["annual_debt_service"], locations)["value"] == 1_000_000


def test_template_keys_are_the_only_emittable_lines():
    assert len(spreading.SPREAD_TEMPLATE) == len(spreading.TEMPLATE_KEYS)
    assert set(EXPECTED) | UNSUPPORTED == set(spreading.TEMPLATE_KEYS)


# ---------------------------------------------------------------- agent-proposal validation


def _facts_fixture():
    return {
        "locations": [
            {"id": 11, "document_id": 3, "page_number": 1, "section": "IS", "extracted_text": "EBITDA 1,420,000;"},
        ],
        "documents": {3: {"original_filename": "f.pdf", "document_type": "financial_statements"}},
        "locations_by_document": {3: []},
        "document_rows": [],
        "location_ids": [11],
        "period": "FY2025",
    }


def test_agent_proposal_admitted_when_the_cited_location_states_the_figure():
    reply = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1420000, "document_id": 3, "document_location_id": 11}]})
    proposal = spreading.parse_spread_reply(reply, _facts_fixture())
    assert proposal["ebitda"]["value"] == 1_420_000


def test_agent_proposal_refused_when_the_cited_location_does_not_state_the_figure():
    """The model may select a figure; it may never author one."""
    reply = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1999999, "document_id": 3, "document_location_id": 11}]})
    assert spreading.parse_spread_reply(reply, _facts_fixture()) is None


def test_agent_proposal_refused_when_a_figure_is_uncited():
    reply = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1420000}]})
    assert spreading.parse_spread_reply(reply, _facts_fixture()) is None


def test_agent_proposal_refused_for_an_off_template_line_item():
    reply = json.dumps({"line_items": [{"line_item_key": "goodwill_addback", "value": 1420000, "document_location_id": 11}]})
    assert spreading.parse_spread_reply(reply, _facts_fixture()) is None


def test_agent_proposal_refused_when_it_cites_a_location_from_another_deal():
    reply = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1420000, "document_location_id": 999}]})
    assert spreading.parse_spread_reply(reply, _facts_fixture()) is None


def test_all_null_agent_proposal_falls_back_to_the_record():
    reply = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": None}]})
    assert spreading.parse_spread_reply(reply, _facts_fixture()) is None


# ---------------------------------------------------------------- the drafting gate


def test_spread_requires_an_accepted_triage_draft():
    _submit("S2-GATE-1")
    response = _spread("S2-GATE-1")
    assert response.status_code == 409
    assert "triage" in response.json()["detail"]


def test_spread_denied_to_a_relationship_manager():
    reference = "S2-RBAC-1"
    _submit(reference)
    _accept_triage(reference)
    response = _spread(reference, actor="rm.rivera")
    assert response.status_code == 403


def test_spread_denied_to_an_unknown_actor():
    reference = "S2-RBAC-2"
    _submit(reference)
    _accept_triage(reference)
    assert _spread(reference, actor="mallory").status_code == 403


def test_spread_draft_is_pending_with_a_citation_on_every_figure():
    reference = "S2-SPREAD-1"
    _submit(reference)
    _accept_triage(reference)
    body = _spread(reference).json()

    assert body["review_status"] == "pending"
    assert body["created"] is True
    assert body["deal"]["current_stage"] == "financial_spreading"
    assert body["uncited_value_count"] == 0

    lines = {line["line_item_key"]: line for line in body["spread_line_items"]}
    assert set(lines) == set(spreading.TEMPLATE_KEYS)
    for key, expected in EXPECTED.items():
        assert lines[key]["value"] == expected, key
        citation = lines[key]["citation"]
        assert citation["document_id"] and citation["document_location_id"], key
        assert citation["source_type"] == "document_location"
    for key in UNSUPPORTED:
        assert lines[key]["value"] is None
        assert lines[key]["display_value"] == spreading.NOT_SUPPORTED
    assert sorted(body["unsupported_lines"]) == sorted(UNSUPPORTED)
    assert len(body["citations"]) == len(EXPECTED)


def test_every_citation_resolves_to_a_real_document_location_on_this_deal():
    reference = "S2-CITE-1"
    _submit(reference)
    _accept_triage(reference)
    body = _spread(reference).json()
    deal = uw.require_deal(reference)
    own_locations = {loc["id"]: loc for loc in uw.locations_for([d["id"] for d in uw.documents_for(deal["id"])])}
    for citation in body["citations"]:
        location = own_locations.get(citation["document_location_id"])
        assert location is not None, citation
        assert location["document_id"] == citation["document_id"]
        # the cited location must actually state the figure
        assert spreading.value_supported_by(location["extracted_text"], citation["value"])


def test_spread_draft_is_idempotent():
    reference = "S2-IDEM-1"
    _submit(reference)
    _accept_triage(reference)
    first = _spread(reference).json()
    second = _spread(reference).json()
    assert second["created"] is False
    assert second["id"] == first["id"]


def test_spread_draft_writes_no_deal_of_record_data_before_acceptance():
    reference = "S2-NOWRITE-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    deal = uw.require_deal(reference)
    assert spreading.current_spread(deal["id"]) == []
    assert deal["current_stage"] == "financial_spreading"


def test_spread_agent_run_records_its_telemetry():
    reference = "S2-TELEM-1"
    _submit(reference)
    _accept_triage(reference)
    body = _spread(reference).json()
    run = body["agent_run"]
    assert run["model_id"] and run["prompt_template_version"].startswith("financial_spread@v")
    assert run["latency_ms"] is not None
    assert run["token_cost"] is not None
    assert run["input_tokens"] and run["output_tokens"]


def test_spread_with_no_extractable_documents_says_not_supported_rather_than_guessing():
    reference = "S2-EMPTY-1"
    _submit(reference, documents=[])
    _accept_triage(reference)
    body = _spread(reference).json()
    assert body["supported_line_count"] == 0
    assert len(body["unsupported_lines"]) == len(spreading.TEMPLATE_KEYS)
    assert spreading.NOT_SUPPORTED in body["rationale"]
    assert body["citations"] == []


# ---------------------------------------------------------------- the human gate


def test_rejecting_a_spread_without_a_reason_is_refused():
    reference = "S2-REJECT-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review", json={"action": "rejected", "acting_user": "an.chen"}
    )
    assert response.status_code == 400
    assert "reason" in response.json()["detail"]
    deal = uw.require_deal(reference)
    assert spreading.current_spread(deal["id"]) == []
    assert deal["current_stage"] == "financial_spreading"


def test_rejecting_a_spread_with_a_reason_records_it_and_promotes_nothing():
    reference = "S2-REJECT-2"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "EBITDA line reads the tax return, not the FYE package."},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["review_status"] == "rejected"
    assert body["draft"]["review_reason"].startswith("EBITDA line")
    deal = uw.require_deal(reference)
    assert spreading.current_spread(deal["id"]) == []
    assert deal["current_stage"] == "financial_spreading"


def test_the_submitter_may_not_review_the_spread_on_their_own_deal():
    reference = "S2-SOD-1"
    body = {
        "deal_reference": reference,
        "borrower_name": "Ridgeline Composites LLC",
        "borrower_industry": "aerospace composites manufacturing",
        "borrower_state": "North Carolina",
        "facility_type": "term_loan",
        "requested_amount": 820000,
        "collateral_value": 1150000,
        "submitted_by": "co.brennan",
        "documents": [
            {"document_type": "financial_statements", "original_filename": "f.pdf", "content_type": "application/pdf", "text": FINANCIALS}
        ],
    }
    assert client.post("/deals", json=body).status_code == 200
    _accept_triage(reference, actor="an.chen")
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "co.brennan"}
    )
    assert response.status_code == 403
    assert "segregation of duties" in response.json()["detail"]


def test_accepting_the_spread_persists_line_items_with_citations_and_advances_the_stage():
    reference = "S2-ACCEPT-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["review_action"] == "accepted"
    assert body["reviewed_by_user_id"] == "an.chen"
    assert body["current_stage"] == "risk_grading"

    promoted = body["promoted"]
    assert len(promoted["spread_line_item_ids"]) == len(spreading.TEMPLATE_KEYS)
    assert len(promoted["citation_ids"]) == len(EXPECTED)
    assert promoted["uncited_figure_count"] == 0

    record = client.get(f"/deals/{reference}/spread").json()["spread_of_record"]
    values = {line["line_item_key"]: line for line in record["line_items"]}
    for key, expected in EXPECTED.items():
        assert values[key]["value"] == expected
        assert values[key]["citation"]["document_location_id"]
    assert record["accepted_by_user_id"] == "an.chen"


def test_acceptance_appends_an_audit_row_naming_the_human():
    reference = "S2-AUDIT-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    rows = [
        row
        for row in uw.store.list("audit_log")
        if row.get("deal_reference") == reference and row["event_type"] == "spread.persisted"
    ]
    assert rows, "accepting a spread must append an audit row"
    assert rows[-1]["actor_user_id"] == "an.chen"
    assert rows[-1]["actor_role"] == "credit_analyst"
    assert rows[-1]["new_values"]["spread_line_item_ids"]


def test_edit_and_accept_records_the_correction_as_the_humans_own():
    reference = "S2-EDIT-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={
            "action": "edited",
            "acting_user": "an.chen",
            "edits": {"line_items": {"ebitda": {"value": 1380000, "note": "addback reversed on review"}}},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["review_action"] == "edited"
    assert body["draft"]["human_edits"]["line_items"]["ebitda"] == {
        "from": 1420000.0,
        "to": 1380000.0,
        "note": "addback reversed on review",
    }
    record = client.get(f"/deals/{reference}/spread").json()["spread_of_record"]
    ebitda = [line for line in record["line_items"] if line["line_item_key"] == "ebitda"][0]
    assert ebitda["value"] == 1380000
    # a human-corrected figure must never keep wearing the agent's citation
    assert ebitda["citation"]["source_type"] == "human_correction"
    assert ebitda["citation"]["document_location_id"] is None


def test_edit_rejects_an_off_template_line():
    reference = "S2-EDIT-2"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={"action": "edited", "acting_user": "an.chen", "edits": {"line_items": {"goodwill": {"value": 1}}}},
    )
    assert response.status_code == 400


def test_edit_with_no_line_items_is_refused():
    reference = "S2-EDIT-3"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    response = client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={"action": "edited", "acting_user": "an.chen", "edits": {}},
    )
    assert response.status_code == 400


# ---------------------------------------------------------------- workspace + guards


def test_review_queue_lists_every_agent_draft():
    reference = "S2-QUEUE-1"
    _submit(reference)
    body = client.get("/reviews").json()
    rows = [row for row in body["drafts"] if row["deal_reference"] == reference]
    assert rows and rows[0]["draft_type"] == "triage"
    assert rows[0]["artifact"] == "Triage classification"
    assert body["pending_count"] >= 1


def test_review_workspace_pairs_the_draft_with_its_evidence():
    reference = "S2-WS-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    body = client.get(f"/reviews/{reference}/spread").json()
    assert body["gate"]["pending"] is True
    assert body["gate"]["blocks_stage"] == "risk_grading"
    citations = [item for item in body["evidence"] if item["kind"] == "citation"]
    absent = [item for item in body["evidence"] if item["kind"] == "absent"]
    assert len(citations) == len(EXPECTED)
    assert len(absent) == len(UNSUPPORTED)
    for item in citations:
        assert item["excerpt"]
        assert item["document_location_id"]


def test_review_workspace_404s_for_a_draft_type_with_no_draft():
    reference = "S2-WS-2"
    _submit(reference)
    assert client.get(f"/reviews/{reference}/spread").status_code == 404


def test_spread_tables_cannot_be_written_through_the_generic_table_api():
    for table in ("spread_line_items", "citations"):
        response = client.post(f"/api/{table}", json={"deal_id": 1, "value": 1})
        assert response.status_code == 403, table


def test_generic_reads_never_leak_borrower_document_text():
    reference = "S2-LEAK-1"
    _submit(reference)
    rows = client.get("/api/document_locations").json()
    assert rows
    assert all("extracted_text" not in row for row in rows)


def test_spread_endpoint_honours_row_scoping():
    """A reference names a deal, but naming one must not walk around scoping."""
    reference = "S2-SCOPE-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    token = client.post("/auth/login", json={"username": "rm.chen.other"}).json()
    # unknown user gets a token but owns no deals; rls scopes them to nothing
    headers = {"Authorization": "Bearer " + token["token"]}
    assert client.get(f"/deals/{reference}/spread", headers=headers).status_code == 404


# ---------------------------------------------------------------- workflow contract


def test_persist_spread_handler_is_registered():
    assert "persist_spread_line_items" in workflow_engine._handlers


def test_persist_spread_handler_satisfies_its_output_schema():
    reference = "S2-WF-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    deal = uw.require_deal(reference)
    output = spreading.handler_persist_spread_line_items({"register_deal": {"deal_id": reference}})
    node = _node("deal-underwriting", "persist_spread")
    for field in node["output_schema"]["required"]:
        assert field in output, field
    assert output["reviewed_by_user_id"] == "an.chen"
    # idempotent: confirming the accepted spread must not double-write it
    assert len(spreading.current_spread(deal["id"])) == len(spreading.TEMPLATE_KEYS)


def test_persist_spread_handler_refuses_an_unaccepted_spread():
    reference = "S2-WF-2"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    with pytest.raises(workflow_engine.WorkflowError):
        spreading.handler_persist_spread_line_items({"register_deal": {"deal_id": reference}})


def _node(workflow_name, node_id):
    workflow = next(w for w in workflow_engine.definitions() if w["name"] == workflow_name)
    return next(n for n in workflow["nodes"] if n["id"] == node_id)


def test_run_is_left_resumable_rather_than_failed_when_a_later_slice_owns_the_tail():
    """The deal-underwriting tail (ratios, grade, memo stage) belongs to a later
    slice. Driving the run into it would mark the run FAILED and strand the
    process, so acceptance leaves it parked on its dispositioned gate."""
    reference = "S2-WF-3"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    body = client.post(
        f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"}
    ).json()
    workflow = body["promoted"]["workflow"]
    deal = uw.require_deal(reference)
    state = workflow_engine.state(deal["workflow_run_id"])
    assert state["status"] != "failed"
    if workflow["status"] == "deferred":
        assert workflow["awaiting_handler"] == "compute_financial_ratios"


def test_triage_acceptance_still_drives_the_process_into_the_spreading_node():
    """Slice 1's path must not regress: accepting triage runs the approved
    process on to the spreading agent node and parks on its human gate."""
    reference = "S2-WF-4"
    _submit(reference)
    _accept_triage(reference)
    deal = uw.require_deal(reference)
    state = workflow_engine.state(deal["workflow_run_id"])
    assert state["status"] == "parked"
    assert (state["context"].get("spread_financials") or {}).get("reply")
    # and the parked draft is the process's OWN output, not a second run
    body = _spread(reference).json()
    assert body["agent_run"]["prompt_template_version"].startswith("financial_spread@v")
    runs = [
        row
        for row in uw.store.list("agent_runs")
        if row.get("deal_reference") == reference and row["agent_type"] == "financial_spreading"
    ]
    assert len(runs) == 1


# ---------------------------------------------------------------- review-fix regressions


def test_rejecting_a_draft_leaves_the_process_gate_open_for_a_redraft():
    """workflows.json models a rejection as a loop BACK to the drafting node,
    but the engine fails a run the moment it resumes past a rejected gate. The
    gate therefore stays open: reject, re-draft, accept — and the run resumes."""
    reference = "S2-LOOP-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    deal = uw.require_deal(reference)
    run_id = deal["workflow_run_id"]
    gate = uw.pending_draft(deal["id"], "spread")["approval_item_id"]

    client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "re-spread against the audited package"},
    )
    assert workflow_engine.state(run_id)["status"] != "failed"
    import approval_flow  # noqa: PLC0415 — asserted here, not a runtime dependency

    assert approval_flow._find(gate)["status"] == "pending"

    # the re-draft reuses that same still-open gate
    redraft = _spread(reference).json()
    assert redraft["approval_item_id"] == gate
    accepted = client.post(
        f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"}
    )
    assert accepted.status_code == 200
    assert approval_flow._find(gate)["status"] == "approved"


def test_rejecting_triage_does_not_kill_the_run_either():
    reference = "S2-LOOP-2"
    _submit(reference)
    deal = uw.require_deal(reference)
    client.post(
        f"/deals/{reference}/drafts/triage/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "document set is stale"},
    )
    assert workflow_engine.state(deal["workflow_run_id"])["status"] != "failed"


def test_adopted_workflow_spread_records_a_real_latency():
    """The spread node runs inside the workflow tick, so its run record takes
    that tick's wall clock — never a fabricated zero."""
    reference = "S2-LATENCY-1"
    _submit(reference)
    _accept_triage(reference)
    body = _spread(reference).json()
    assert body["source"] != "fabricated"
    assert body["agent_run"]["latency_ms"] > 0


def test_uncited_count_has_one_definition_across_agent_and_edit_paths():
    reference = "S2-UNCITED-1"
    _submit(reference)
    _accept_triage(reference)
    drafted = _spread(reference).json()
    assert drafted["uncited_value_count"] == 0
    edited = client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={
            "action": "edited",
            "acting_user": "an.chen",
            "edits": {"line_items": {"ebitda": {"value": 1380000, "note": "addback reversed"}}},
        },
    ).json()
    # a human correction is cited to the human, so it is not "uncited"
    assert edited["draft"]["uncited_value_count"] == 0
    assert edited["promoted"]["uncited_figure_count"] == 0


def test_generic_reads_never_leak_citation_excerpts_or_raw_model_output():
    reference = "S2-LEAK-2"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    dumped = json.dumps(
        [client.get(f"/api/{table}").json() for table in ("citations", "agent_drafts", "agent_runs")]
    )
    assert "Cost of Goods Sold 7,300,000" not in dumped
    assert '"excerpt"' not in dumped
    assert '"raw_output"' not in dumped
    # the deal-scoped workspace still shows the analyst what a figure rests on
    workspace = client.get(f"/reviews/{reference}/spread").json()
    assert any("7,300,000" in (item.get("excerpt") or "") for item in workspace["evidence"])


def test_draft_list_is_row_scoped():
    reference = "S2-SCOPE-2"
    _submit(reference)
    token = client.post("/auth/login", json={"username": "not.a.real.user"}).json()["token"]
    response = client.get(f"/deals/{reference}/drafts", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 404


def test_guarded_tables_cannot_drift_from_the_middlewares_governed_set():
    import ext_guard  # noqa: PLC0415
    import main  # noqa: PLC0415

    assert main.GUARDED_TABLES == ext_guard.GOVERNED_TABLES
    for table in ("spread_line_items", "citations", "memos", "policy_rules"):
        assert table in main.GUARDED_TABLES


def test_review_trail_reads_the_append_only_record():
    reference = "S2-TRAIL-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    body = client.get(f"/reviews/{reference}/spread/trail").json()
    events = {entry["event_type"] for entry in body["entries"]}
    assert "agent_draft.created" in events
    assert "spread.persisted" in events
    assert body["append_only"] is True
    assert all(entry["audit_log_id"] for entry in body["entries"])


def test_review_trail_is_row_scoped():
    reference = "S2-TRAIL-2"
    _submit(reference)
    token = client.post("/auth/login", json={"username": "not.a.real.user"}).json()["token"]
    assert client.get(f"/reviews/{reference}/triage/trail", headers={"Authorization": "Bearer " + token}).status_code == 404


def test_a_malformed_model_reply_is_refused_not_crashed():
    """A live model can return anything — a list where an id belongs, a bool
    for a value. None of it may reach an analyst as a 500."""
    facts = _facts_fixture()
    for reply in (
        '{"line_items": [{"line_item_key": ["ebitda"], "value": 1420000, "document_location_id": 11}]}',
        '{"line_items": [{"line_item_key": "ebitda", "value": 1420000, "document_location_id": [11]}]}',
        '{"line_items": [{"line_item_key": "ebitda", "value": true, "document_location_id": 11}]}',
        '{"line_items": [{"line_item_key": "ebitda", "value": 1e400, "document_location_id": 11}]}',
        '{"line_items": ["ebitda"]}',
        '{"line_items": []}',
        "no json here at all",
    ):
        assert spreading.parse_spread_reply(reply, facts) is None


def test_csv_export_never_carries_borrower_statement_text_in_a_nested_column():
    """agent_drafts.draft_content is a JSON column: filtering column NAMES is
    not enough, the nested citation excerpts have to go too."""
    reference = "S2-EXPORT-1"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    for table in ("agent_drafts", "citations", "agent_runs", "document_locations"):
        body = client.get(f"/export/{table}.csv").text
        assert "Cost of Goods Sold 7,300,000" not in body, table
        assert "excerpt" not in body, table


def test_triage_endpoint_is_row_scoped_like_every_other_deal_route():
    reference = "S2-SCOPE-3"
    _submit(reference)
    token = client.post("/auth/login", json={"username": "not.a.real.user"}).json()["token"]
    response = client.post(
        f"/deals/{reference}/triage", json={"acting_user": "an.chen"}, headers={"Authorization": "Bearer " + token}
    )
    assert response.status_code in (403, 404)


def test_a_reused_gate_describes_the_draft_it_now_guards():
    """A gate left open by a rejection must not keep advertising the draft that
    was rejected in GET /workflow/submissions/pending."""
    import approval_flow  # noqa: PLC0415

    reference = "S2-GATEPAYLOAD-1"
    _submit(reference)
    _accept_triage(reference)
    first = _spread(reference).json()
    gate = first["approval_item_id"]
    client.post(
        f"/deals/{reference}/drafts/spread/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "wrong statement package"},
    )
    redraft = _spread(reference).json()
    assert redraft["approval_item_id"] == gate
    item = approval_flow._find(gate)
    assert item["status"] == "pending"
    assert item["payload"]["draft_type"] == "spread"
    assert item["payload"]["summary"] == (redraft["rationale"] or "")[:200]


def test_trail_is_bounded_to_the_draft_that_produced_it():
    reference = "S2-TRAIL-3"
    _submit(reference)
    _accept_triage(reference)
    _spread(reference)
    client.post(f"/deals/{reference}/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    triage_trail = client.get(f"/reviews/{reference}/triage/trail").json()
    spread_trail = client.get(f"/reviews/{reference}/spread/trail").json()
    triage_events = {e["event_type"] for e in triage_trail["entries"]}
    spread_events = {e["event_type"] for e in spread_trail["entries"]}
    # the triage draft's window closes when the spread draft is created
    assert "spread.persisted" not in triage_events
    assert "agent_draft.accepted" in triage_events
    assert "spread.persisted" in spread_events
    assert all(e["audit_log_id"] for e in spread_trail["entries"])
