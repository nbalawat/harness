"""Slice 2 — financial spreading agent and the Draft Review workspace.

Same style as the generated harness: stub agent mode pinned, TestClient over
the composed app.
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
import row_history  # noqa: E402
import workflow_engine  # noqa: E402
from db import store  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

FINANCIALS = (
    "FY2025 Audited Financial Statements - Piedmont Orthopedic Devices LLC. Income Statement: "
    "Revenue 12,400,000; Cost of Goods Sold 7,300,000; Operating Expenses 3,680,000; EBITDA 1,420,000; "
    "Interest Expense 310,000. Balance Sheet: Current Assets 3,300,000; Current Liabilities 1,650,000; "
    "Total Debt 5,600,000; Tangible Net Worth 2,800,000. Debt Service: Annual Principal and Interest 1,000,000."
)
TAX_RETURN = (
    "Form 1120S tax year 2025 - Piedmont Orthopedic Devices LLC. Gross receipts 12,400,000. "
    "Ordinary business income 1,110,000. Depreciation 620,000."
)


def _submit(reference, documents=None):
    body = {
        "deal_reference": reference,
        "borrower_name": "Piedmont Orthopedic Devices LLC",
        "borrower_industry": "surgical instrument manufacturing",
        "borrower_state": "North Carolina",
        "facility_type": "term_loan",
        "requested_amount": 780000,
        "collateral_value": 1100000,
        "purpose": "CNC line expansion",
        "submitted_by": "rm.rivera",
        "documents": [
            {"document_type": "financial_statements", "original_filename": "2025-FYE-Financials.pdf", "content_type": "application/pdf", "text": FINANCIALS},
            {"document_type": "business_tax_return", "original_filename": "1120S-2025.pdf", "content_type": "application/pdf", "text": TAX_RETURN},
        ]
        if documents is None
        else documents,
    }
    response = client.post("/deals", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _accept_triage(reference, actor="an.chen"):
    response = client.post(f"/deals/{reference}/drafts/triage/review", json={"action": "accepted", "acting_user": actor})
    assert response.status_code == 200, response.text
    return response.json()


def _spread(reference, actor="an.chen"):
    response = client.post(f"/deals/{reference}/spread", json={"acting_user": actor})
    assert response.status_code == 200, response.text
    return response.json()


def _deal_row(reference):
    return uw.require_deal(reference)


# ---------------------------------------------------------------- deterministic units


def test_every_template_line_is_filled_or_named_unsupported():
    _submit("T-SPREAD-UNIT-01")
    _accept_triage("T-SPREAD-UNIT-01")
    deal = _deal_row("T-SPREAD-UNIT-01")
    items = spreading.derive_line_items(deal)

    assert [item["line_item_key"] for item in items] == [spec["key"] for spec in spreading.SPREAD_TEMPLATE]
    values = {item["line_item_key"]: item["value"] for item in items}
    assert values["revenue"] == 12_400_000.0
    assert values["cost_of_goods_sold"] == 7_300_000.0
    assert values["ebitda"] == 1_420_000.0
    assert values["current_assets"] == 3_300_000.0
    assert values["current_liabilities"] == 1_650_000.0
    assert values["total_debt"] == 5_600_000.0
    assert values["tangible_net_worth"] == 2_800_000.0
    assert values["annual_debt_service"] == 1_000_000.0
    # Lines the documents do not state carry the phrase, never a guess.
    assert values["gross_profit"] is None
    for item in items:
        if item["value"] is None:
            assert item["citation"]["source_reference"] == spreading.NOT_SUPPORTED
        else:
            # REQ-031: every single figure names its document AND its location.
            assert item["citation"]["document_id"] is not None
            assert item["citation"]["document_location_id"] is not None


def test_figures_are_cited_to_the_document_they_were_read_from():
    _submit("T-SPREAD-UNIT-02")
    _accept_triage("T-SPREAD-UNIT-02")
    deal = _deal_row("T-SPREAD-UNIT-02")
    by_key = {item["line_item_key"]: item for item in spreading.derive_line_items(deal)}
    # the audited statements, not the tax return, back the income statement
    assert by_key["revenue"]["citation"]["document_filename"] == "2025-FYE-Financials.pdf"
    assert "Revenue 12,400,000" in by_key["revenue"]["citation"]["excerpt"]
    # depreciation appears only on the return, so that is what it cites
    assert by_key["depreciation_amortisation"]["citation"]["document_filename"] == "1120S-2025.pdf"
    assert by_key["revenue"]["period"] == "FY2025"


def test_agent_figures_are_admitted_only_when_the_cited_location_states_them():
    _submit("T-SPREAD-UNIT-03")
    _accept_triage("T-SPREAD-UNIT-03")
    deal = _deal_row("T-SPREAD-UNIT-03")
    documents, locations = spreading.deal_locations(deal)
    ebitda_location = next(loc for loc in locations if "EBITDA" in loc["extracted_text"])

    honest = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1420000, "document_id": ebitda_location["document_id"], "document_location_id": ebitda_location["id"]}]})
    parsed = spreading.parse_spread_reply(honest, documents=documents, locations=locations)
    assert parsed is not None
    assert {item["line_item_key"]: item["value"] for item in parsed}["ebitda"] == 1_420_000.0

    # A number the cited location does not state is refused outright — this is
    # what keeps LLM arithmetic out of the deal of record.
    invented = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1500000, "document_id": ebitda_location["document_id"], "document_location_id": ebitda_location["id"]}]})
    assert spreading.parse_spread_reply(invented, documents=documents, locations=locations) is None

    # So is a citation to a location outside this deal's own documents.
    foreign = json.dumps({"line_items": [{"line_item_key": "ebitda", "value": 1420000, "document_id": 999999, "document_location_id": 999999}]})
    assert spreading.parse_spread_reply(foreign, documents=documents, locations=locations) is None

    # So is a line item that is not on the approved template.
    off_template = json.dumps({"line_items": [{"line_item_key": "owner_addback", "value": 1420000, "document_id": ebitda_location["document_id"], "document_location_id": ebitda_location["id"]}]})
    assert spreading.parse_spread_reply(off_template, documents=documents, locations=locations) is None


def test_a_model_figure_is_refused_unless_the_cited_line_is_the_one_it_names():
    """Three ways a plausible-looking citation can still be wrong, all refused."""
    _submit("T-SPREAD-UNIT-05")
    _accept_triage("T-SPREAD-UNIT-05")
    deal = _deal_row("T-SPREAD-UNIT-05")
    documents, locations = spreading.deal_locations(deal)
    revenue_location = next(loc for loc in locations if "Revenue 12,400,000" in loc["extracted_text"])

    def reply(key, value, location):
        return json.dumps({"line_items": [{"line_item_key": key, "value": value, "document_id": location["document_id"], "document_location_id": location["id"]}]})

    # (a) a real number filed under a line the cited location does not name —
    #     revenue's location cannot back "total funded debt"
    assert spreading.parse_spread_reply(reply("total_debt", 12400000, revenue_location), documents=documents, locations=locations) is None
    # (b) a digit substring of a figure the location states is not that figure
    assert spreading.parse_spread_reply(reply("revenue", 124, revenue_location), documents=documents, locations=locations) is None
    assert spreading.parse_spread_reply(reply("revenue", 12400, revenue_location), documents=documents, locations=locations) is None
    # (c) the sign is part of the figure
    assert spreading.parse_spread_reply(reply("revenue", -12400000, revenue_location), documents=documents, locations=locations) is None
    # and the honest reading still validates, cited as the document renders it
    parsed = spreading.parse_spread_reply(reply("revenue", 12400000, revenue_location), documents=documents, locations=locations)
    assert parsed is not None
    revenue = next(item for item in parsed if item["line_item_key"] == "revenue")
    assert revenue["citation"]["cited_value"] == "12,400,000"


def test_a_label_the_app_cannot_parse_a_figure_from_is_not_evidence_for_one():
    """Prose that mentions a template line but states someone else's number
    must not be able to put that number on the line."""
    location = {
        "id": 1,
        "document_id": 1,
        "extracted_text": "Current assets increased over the prior period; total funded debt of 8,000,000 was refinanced",
    }
    current_assets = spreading.TEMPLATE_BY_KEY["current_assets"]
    assert spreading._states_value(location, current_assets, 8_000_000.0) is False
    # the line the location really states still validates
    total_debt = spreading.TEMPLATE_BY_KEY["total_debt"]
    assert spreading._states_value(location, total_debt, 8_000_000.0) is True


def test_stated_numbers_reads_whole_tokens_only():
    assert spreading.stated_numbers("Revenue 12,400,000; EBITDA 1,420,000;") == {12_400_000.0, 1_420_000.0}
    assert spreading.stated_numbers("Net income (450,000)") == {-450_000.0}
    assert 124.0 not in spreading.stated_numbers("Revenue 12,400,000;")


def test_spread_carries_no_ratio_or_grade():
    _submit("T-SPREAD-UNIT-04")
    _accept_triage("T-SPREAD-UNIT-04")
    draft = _spread("T-SPREAD-UNIT-04")
    keys = {item["line_item_key"] for item in draft["spread_line_items"]}
    assert not keys & {"dscr", "leverage", "current_ratio", "risk_grade"}
    body = json.dumps(draft).lower()
    assert "dscr" not in body


# ---------------------------------------------------------------- the gate


def test_spread_requires_the_triage_gate_first():
    _submit("T-SPREAD-GATE-01")
    response = client.post("/deals/T-SPREAD-GATE-01/spread", json={"acting_user": "an.chen"})
    assert response.status_code == 409
    assert "triage" in response.json()["detail"]


def test_spread_denies_a_role_without_the_grant():
    _submit("T-SPREAD-RBAC-01")
    _accept_triage("T-SPREAD-RBAC-01")
    response = client.post("/deals/T-SPREAD-RBAC-01/spread", json={"acting_user": "rm.rivera"})
    assert response.status_code == 403
    response = client.post("/deals/T-SPREAD-RBAC-01/spread", json={"acting_user": "nobody.here"})
    assert response.status_code == 403
    response = client.post("/deals/T-SPREAD-RBAC-01/spread", json={})
    assert response.status_code == 401


def test_draft_is_pending_and_persists_nothing_until_a_human_accepts():
    _submit("T-SPREAD-PEND-01")
    _accept_triage("T-SPREAD-PEND-01")
    draft = _spread("T-SPREAD-PEND-01")
    deal = _deal_row("T-SPREAD-PEND-01")

    assert draft["review_status"] == "pending"
    assert draft["draft_type"] == "spread"
    assert spreading.accepted_spread(deal["id"]) == ([], [])
    assert deal["current_stage"] == "financial_spreading"

    # the parked human gate is the workflow's own spread_review node
    item = None
    for row in store.list("_approvals_queue"):
        if row["id"] == draft["approval_item_id"]:
            item = row
    assert item is not None and item["status"] == "pending"


def test_rejection_without_a_reason_is_refused_and_with_one_is_recorded():
    _submit("T-SPREAD-REJ-01")
    _accept_triage("T-SPREAD-REJ-01")
    _spread("T-SPREAD-REJ-01")

    refused = client.post("/deals/T-SPREAD-REJ-01/drafts/spread/review", json={"action": "rejected", "acting_user": "an.chen"})
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]

    rejected = client.post(
        "/deals/T-SPREAD-REJ-01/drafts/spread/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "EBITDA is stated before the owner add-back; re-run against the debt schedule."},
    )
    assert rejected.status_code == 200
    deal = _deal_row("T-SPREAD-REJ-01")
    # a rejection persists nothing and does not advance the deal
    assert spreading.accepted_spread(deal["id"]) == ([], [])
    assert deal["current_stage"] == "financial_spreading"
    assert any(
        row["event_type"] == "agent_draft.rejected" and row["deal_reference"] == "T-SPREAD-REJ-01"
        for row in store.list("audit_log")
    )
    # a rejected gate ends its run at that node — nothing is deferred, because
    # the tick reaches no handler at all
    state = workflow_engine.state(deal["workflow_run_id"])
    assert state["status"] == "failed"
    # and the analyst can still re-run the agent for a fresh draft behind a
    # fresh human gate
    again = _spread("T-SPREAD-REJ-01")
    assert again["review_status"] == "pending"
    assert again["approval_item_id"] is not None


def test_acceptance_persists_line_items_with_citations_and_advances_the_deal():
    _submit("T-SPREAD-ACC-01")
    _accept_triage("T-SPREAD-ACC-01")
    _spread("T-SPREAD-ACC-01")
    accepted = client.post("/deals/T-SPREAD-ACC-01/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()

    assert body["review_action"] == "accepted"
    assert body["reviewed_by_user_id"] == "an.chen"
    assert body["current_stage"] == "risk_grading"
    promoted = body["promoted"]
    assert len(promoted["spread_line_item_ids"]) == len(spreading.SPREAD_TEMPLATE)
    assert len(promoted["citation_ids"]) == len(spreading.SPREAD_TEMPLATE)

    deal = _deal_row("T-SPREAD-ACC-01")
    items, citations = spreading.accepted_spread(deal["id"])
    assert {item["id"] for item in items} == set(promoted["spread_line_item_ids"])
    # every persisted line item has exactly one citation row
    assert sorted(c["spread_line_item_id"] for c in citations) == sorted(item["id"] for item in items)
    for item in items:
        citation = next(c for c in citations if c["spread_line_item_id"] == item["id"])
        if item["value"] is None:
            assert citation["source_reference"] == spreading.NOT_SUPPORTED
        else:
            assert citation["document_id"] and citation["document_location_id"]
    assert any(row["event_type"] == "spread.accepted" and row["actor_user_id"] == "an.chen" for row in store.list("audit_log"))

    # idempotent: a replayed acceptance never doubles the spread of record
    replay = spreading.persist_accepted_spread(deal, {"line_items": []}, {"username": "an.chen"})
    assert replay["already_on_file"] is True
    assert len(spreading.accepted_spread(deal["id"])[0]) == len(items)


def test_edit_records_the_diff_and_recites_the_figure_to_the_human():
    _submit("T-SPREAD-EDIT-01")
    _accept_triage("T-SPREAD-EDIT-01")
    _spread("T-SPREAD-EDIT-01")
    edited = client.post(
        "/deals/T-SPREAD-EDIT-01/drafts/spread/review",
        json={"action": "edited", "acting_user": "an.chen", "edits": {"line_items": {"ebitda": 1350000}}, "reason": "owner add-back removed"},
    )
    assert edited.status_code == 200, edited.text
    diff = edited.json()["draft"]["human_edits"]
    assert diff["line_items.ebitda"] == {"from": 1420000.0, "to": 1350000.0}

    deal = _deal_row("T-SPREAD-EDIT-01")
    items, citations = spreading.accepted_spread(deal["id"])
    ebitda = next(item for item in items if item["line_item_key"] == "ebitda")
    assert ebitda["value"] == 1350000.0
    citation = next(c for c in citations if c["spread_line_item_id"] == ebitda["id"])
    # the corrected number is the analyst's, and the citation says exactly that
    assert citation["source_type"] == "human_edit"

    # the row-history trail keeps the agent's original figure, so "what did the
    # agent actually produce" survives the edit
    draft_id = edited.json()["draft"]["id"]
    changes = [c for entry in row_history.history("agent_drafts", draft_id) for c in entry["changes"]]
    before_content = next(c["from"] for c in changes if c["field"] == "draft_content")
    original = {item["line_item_key"]: item["value"] for item in before_content["line_items"]}
    assert original["ebitda"] == 1420000.0

    # the citation-integrity counters follow the edit rather than going stale
    content = edited.json()["draft"]["draft_content"]
    assert content["human_edited_count"] == 1
    assert content["uncited_figure_count"] == 0
    assert content["document_cited_count"] == content["supported_count"] - 1

    rejected = client.post(
        "/deals/T-SPREAD-EDIT-01/drafts/spread/review",
        json={"action": "edited", "acting_user": "an.chen", "edits": {"line_items": {"owner_addback": 1}}},
    )
    assert rejected.status_code in (400, 409)


def test_the_two_generic_write_guards_cannot_drift_apart():
    """main.py's in-route guard and the ext_guard middleware must name the same
    governed tables — a slice that adds a table to one and not the other leaves
    a write path around the human gate."""
    import ext_guard
    import main

    assert main.GUARDED_TABLES == set(ext_guard.GOVERNED_TABLES)
    for table in ("spread_line_items", "citations"):
        assert table in main.GUARDED_TABLES


def test_segregation_of_duties_holds_on_the_spread_gate():
    _submit("T-SPREAD-SOD-01", documents=[])
    # the officer who submitted may not also accept the drafts on that deal
    submitted = client.post(
        "/deals",
        json={
            "deal_reference": "T-SPREAD-SOD-02",
            "borrower_name": "Cedar Fork Tooling LLC",
            "borrower_industry": "machine tool manufacturing",
            "borrower_state": "North Carolina",
            "facility_type": "term_loan",
            "requested_amount": 400000,
            "collateral_value": 700000,
            "submitted_by": "co.brennan",
            "documents": [{"document_type": "financial_statements", "original_filename": "fs.pdf", "text": FINANCIALS}],
        },
    )
    assert submitted.status_code == 200
    _accept_triage("T-SPREAD-SOD-02", actor="an.chen")
    _spread("T-SPREAD-SOD-02")
    response = client.post("/deals/T-SPREAD-SOD-02/drafts/spread/review", json={"action": "accepted", "acting_user": "co.brennan"})
    assert response.status_code == 403
    assert "segregation of duties" in response.json()["detail"]


def test_a_deal_with_no_documents_spreads_to_an_honest_empty_template():
    _submit("T-SPREAD-NODOC-01", documents=[])
    _accept_triage("T-SPREAD-NODOC-01")
    draft = _spread("T-SPREAD-NODOC-01")
    assert draft["supported_count"] == 0
    assert draft["unsupported_count"] == len(spreading.SPREAD_TEMPLATE)
    for item in draft["spread_line_items"]:
        assert item["citation"]["source_reference"] == spreading.NOT_SUPPORTED


# ---------------------------------------------------------------- telemetry, workspace, workflow


def test_agent_run_records_the_required_telemetry():
    _submit("T-SPREAD-RUN-01")
    _accept_triage("T-SPREAD-RUN-01")
    draft = _spread("T-SPREAD-RUN-01")
    run = next(row for row in store.list("agent_runs") if row["id"] == draft["agent_run_id"])
    assert run["agent_name"] == spreading.SPREAD_AGENT_NAME
    assert run["model_id"]
    # this reply came from the process definition's own node prompt, and the
    # run record names that rather than this module's template
    assert run["prompt_template_version"] == "deal-underwriting/spread_financials@workflows.json"
    assert run["inputs"]["document_location_ids"]
    assert run["raw_output"] is not None
    assert run["token_cost"] is not None
    # this node ran inside the triage-acceptance tick, so its latency is
    # recorded as unknown rather than as a zero that would read as measured
    assert "latency_ms" in run and run["inputs"]["latency_note"]
    assert any(
        row["event_type"] == "agent.run_recorded" and row["entity_id"] == run["id"]
        for row in store.list("audit_log")
    )


def test_review_workspace_serves_every_draft_with_its_evidence():
    _submit("T-SPREAD-WS-01")
    _accept_triage("T-SPREAD-WS-01")
    draft = _spread("T-SPREAD-WS-01")

    queue = client.get("/review/queue?acting_user=an.chen").json()
    references = {row["deal_reference"] for row in queue["drafts"]}
    types = {row["draft_type"] for row in queue["drafts"] if row["deal_reference"] == "T-SPREAD-WS-01"}
    assert "T-SPREAD-WS-01" in references
    assert types == {"triage", "spread"}

    detail = client.get(f"/review/drafts/{draft['id']}?acting_user=an.chen").json()
    assert detail["artifact"] == "Financial spread"
    assert detail["telemetry"]["model_id"]
    assert len(detail["evidence"]) == len(spreading.SPREAD_TEMPLATE)
    cited = [row for row in detail["evidence"] if row["supported"]]
    assert cited and all(row["document_location_id"] for row in cited)
    assert detail["editable_fields"]

    missing = client.get("/review/drafts/99999?acting_user=an.chen")
    assert missing.status_code == 404
    # deny by default: these reads carry borrower figures and document excerpts,
    # so an unnamed caller reads nothing
    assert client.get("/review/queue").status_code == 401
    assert client.get(f"/review/drafts/{draft['id']}").status_code == 401
    assert client.get(f"/deals/{draft['deal_reference']}/spread").status_code == 401


def test_persist_spread_handler_satisfies_its_workflow_contract():
    _submit("T-SPREAD-WF-01")
    _accept_triage("T-SPREAD-WF-01")
    _spread("T-SPREAD-WF-01")
    accepted = client.post("/deals/T-SPREAD-WF-01/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    assert accepted.status_code == 200

    deal = _deal_row("T-SPREAD-WF-01")
    workflow = next(w for w in workflow_engine.definitions() if w["name"] == "deal-underwriting")
    node = next(n for n in workflow["nodes"] if n["id"] == "persist_spread")
    assert node["handler"] in uw.REGISTERED_HANDLERS

    output = spreading.handler_persist_spread_line_items({"register_deal": {"deal_id": deal["deal_reference"]}})
    for field in node["output_schema"]["required"]:
        assert field in output, field
    assert output["reviewed_by_user_id"] == "an.chen"
    # the handler is idempotent — confirming, never doubling, the spread on file
    assert len(spreading.accepted_spread(deal["id"])[0]) == len(spreading.SPREAD_TEMPLATE)


def test_workflow_run_stays_resumable_when_a_later_slice_owns_the_next_handler():
    _submit("T-SPREAD-WF-02")
    _accept_triage("T-SPREAD-WF-02")
    _spread("T-SPREAD-WF-02")
    body = client.post("/deals/T-SPREAD-WF-02/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"}).json()
    workflow = body["promoted"]["workflow"]
    # compute_financial_ratios ships with the ratio slice; rather than driving
    # the run into a failure it cannot recover from, the tick is deferred.
    assert workflow["status"] == "deferred"
    assert workflow["awaiting_handler"] == "compute_financial_ratios"
    state = workflow_engine.state(_deal_row("T-SPREAD-WF-02")["workflow_run_id"])
    assert state["status"] == "parked"


def test_spread_tables_are_not_writable_through_the_generic_api():
    for table in ("spread_line_items", "citations"):
        response = client.post(f"/api/{table}", json={"deal_id": 1, "line_item_key": "ebitda", "value": 99})
        assert response.status_code == 403


def test_document_text_copied_onto_a_citation_does_not_leak_generically():
    """A citation excerpt is borrower document text under another name, so the
    generic reader and the CSV dump must scrub it exactly like extracted_text."""
    _submit("T-SPREAD-LEAK-01")
    _accept_triage("T-SPREAD-LEAK-01")
    _spread("T-SPREAD-LEAK-01")
    client.post("/deals/T-SPREAD-LEAK-01/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})

    for path in ("/api/citations", "/api/agent_drafts", "/api/agent_runs"):
        body = client.get(path).text
        assert "Tangible Net Worth 2,800,000" not in body, path
        assert '"excerpt"' not in body, path
    csv_dump = client.get("/export/citations.csv").text
    assert "excerpt" not in csv_dump


def test_draft_and_spread_reads_are_row_scoped():
    _submit("T-SPREAD-SCOPE-01")  # submitted by rm.rivera
    _accept_triage("T-SPREAD-SCOPE-01")
    _spread("T-SPREAD-SCOPE-01")
    client.post(
        "/deals",
        json={
            "deal_reference": "T-SPREAD-SCOPE-02",
            "borrower_name": "Stonebridge Veterinary Group LLC",
            "borrower_industry": "veterinary services",
            "borrower_state": "North Carolina",
            "facility_type": "term_loan",
            "requested_amount": 300000,
            "collateral_value": 500000,
            "submitted_by": "co.brennan",
            "documents": [{"document_type": "financial_statements", "original_filename": "fs.pdf", "text": FINANCIALS}],
        },
    )
    token = client.post("/auth/login", json={"username": "rm.rivera"}).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    assert client.get("/deals/T-SPREAD-SCOPE-02/drafts", headers=headers).status_code == 404
    assert client.get("/deals/T-SPREAD-SCOPE-02/spread", headers=headers).status_code == 404
    assert client.get("/deals/T-SPREAD-SCOPE-01/drafts", headers=headers).status_code == 200

    queue = client.get("/review/queue", headers=headers).json()
    assert "T-SPREAD-SCOPE-02" not in {row["deal_reference"] for row in queue["drafts"]}
    others = client.get("/review/queue?acting_user=co.brennan").json()["drafts"]
    stranger = next(row for row in others if row["deal_reference"] == "T-SPREAD-SCOPE-02")
    assert client.get(f"/review/drafts/{stranger['id']}", headers=headers).status_code == 404


def test_the_spread_payload_is_not_readable_without_a_named_reader():
    """The three surfaces that serve the same spread must agree: naming a deal
    reference on a slice-1 read cannot be a way around the review gate."""
    _submit("T-SPREAD-ANON-01")
    _accept_triage("T-SPREAD-ANON-01")
    _spread("T-SPREAD-ANON-01")

    assert client.get("/deals/T-SPREAD-ANON-01/drafts").status_code == 401
    named = client.get("/deals/T-SPREAD-ANON-01/drafts?acting_user=an.chen")
    assert named.status_code == 200
    assert any(row["spread_line_items"] for row in named.json() if row["draft_type"] == "spread")

    # GET /deals/{ref} keeps its slice-1 contract (it answers an unnamed
    # caller), but it answers without the borrower figures and the document
    # excerpts this slice added to the draft view.
    anonymous = client.get("/deals/T-SPREAD-ANON-01")
    assert anonymous.status_code == 200
    body = anonymous.text
    assert "Tangible Net Worth 2,800,000" not in body
    spread = next(row for row in anonymous.json()["drafts"] if row["draft_type"] == "spread")
    assert spread["spread_line_items"] == [] and spread["draft_content"] == {}
    assert spread["evidence_withheld"]
    assert spread["review_status"] == "pending"  # the gate itself is still visible


def test_a_deny_by_default_read_does_not_leak_which_deals_exist():
    for path in ("/deals/NOPE-9999/spread", "/deals/NOPE-9999/drafts"):
        assert client.get(path).status_code == 401
    assert client.post("/deals/NOPE-9999/spread", json={}).status_code == 401


def test_a_token_for_an_unknown_name_is_scoped_to_nothing():
    """auth-basic mints a token for whatever name it is handed, so an identity
    the app does not know must scope to no rows rather than to the whole book."""
    token = client.post("/auth/login", json={"username": "ghost.user"}).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/deals", headers=headers).json() == []
    assert client.get("/review/queue", headers=headers).status_code == 403


def test_a_reference_ending_in_digits_still_reads_its_own_documents():
    """Blob ownership is decided by the documents row, not by picking the deal
    reference back out of the blob name: `<ref>-NN-<file>.txt` is ambiguous for
    a reference that itself ends in a two-digit group, which used to leave the
    deal with no extractable text at all."""
    _submit("T-SPREAD-BLOB-07")
    documents = client.get("/deals/T-SPREAD-BLOB-07").json()["documents"]
    assert documents[0]["storage_path"]
    assert uw.locations_for([d["id"] for d in documents])
    # and the cross-deal guard still holds
    assert uw._read_upload(documents[0]["storage_path"], "T-SPREAD-BLOB-08") == ""


@pytest.mark.parametrize(
    "text,expected",
    [
        ("EBITDA 1,420,000;", 1_420_000.0),
        ("EBITDA $1,420,000.50", 1_420_000.5),
        ("EBITDA (250,000)", -250_000.0),
        ("EBITDA not disclosed", None),
    ],
)
def test_figure_matching_is_deterministic(text, expected):
    assert spreading._match_figure(text, "ebitda") == expected
