"""Slice 2 — financial spreading agent + the shared Draft Review workspace.

Same style as slice 1: stub agent mode pinned, TestClient over the composed
app.
"""
import json
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import workflow_engine  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import underwriting as uw  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

FINANCIALS_TEXT = (
    "FY2025 Audited Financial Statements. Income Statement: Revenue 12,400,000; "
    "Cost of Goods Sold 7,300,000; Operating Expenses 3,680,000; EBITDA 1,420,000; "
    "Interest Expense 310,000. Balance Sheet: Current Assets 3,300,000; "
    "Current Liabilities 1,650,000; Total Debt 5,600,000; Tangible Net Worth 2,800,000. "
    "Debt Service: Annual Principal and Interest 1,000,000."
)

DEAL = {
    "deal_reference": "T-SPREAD-1001",
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
            "text": FINANCIALS_TEXT,
        },
        {
            "document_type": "business_tax_return",
            "original_filename": "1120S-2025.pdf",
            "content_type": "application/pdf",
            "text": "Form 1120S tax year 2025. Gross receipts 12,400,000. Depreciation 620,000.",
        },
    ],
}

EXPECTED_VALUES = {
    "revenue": 12_400_000.0,
    "cogs": 7_300_000.0,
    "operating_expenses": 3_680_000.0,
    "ebitda": 1_420_000.0,
    "interest_expense": 310_000.0,
    "current_assets": 3_300_000.0,
    "current_liabilities": 1_650_000.0,
    "total_debt": 5_600_000.0,
    "tangible_net_worth": 2_800_000.0,
    "annual_debt_service": 1_000_000.0,
}


def _submit(overrides=None):
    body = dict(DEAL)
    body.update(overrides or {})
    return client.post("/deals", json=body)


def _advance_to_document_extraction(ref, documents=None):
    _submit({"deal_reference": ref, "documents": documents if documents is not None else DEAL["documents"]})
    client.post(f"/deals/{ref}/triage", json={"acting_user": "an.chen"})
    review = client.post(f"/deals/{ref}/drafts/triage/review", json={"action": "accepted", "acting_user": "an.chen"})
    assert review.status_code == 200
    assert review.json()["current_stage"] == "document_extraction"


# ---------------------------------------------------------------- deterministic units


def test_spread_template_extraction_matches_the_golden_fixture():
    locations = uw.split_into_locations(FINANCIALS_TEXT)
    line_items, citations = uw.derive_spread(
        [dict(loc, id=i, document_id=1) for i, loc in enumerate(locations, start=1)]
    )
    by_key = {li["line_item_key"]: li for li in line_items}
    assert set(by_key) == uw.SPREAD_TEMPLATE_KEYS
    for key, expected in EXPECTED_VALUES.items():
        assert by_key[key]["value"] == expected, key
        assert by_key[key]["supported"] is True
        assert by_key[key]["citation"]["document_id"] == 1
    assert len(citations) == len(EXPECTED_VALUES)


def test_spread_derivation_marks_absent_lines_not_supported_by_the_record():
    line_items, citations = uw.derive_spread([])
    assert citations == []
    assert all(li["value"] is None and li["note"] == "not supported by the record" for li in line_items)


def _locations_from(text):
    parsed = uw.split_into_locations(text)
    return [dict(loc, id=100 + i, document_id=1) for i, loc in enumerate(parsed)]


def test_spread_reply_parser_rejects_a_citation_to_an_unknown_location():
    locations = _locations_from(FINANCIALS_TEXT)
    bogus = json.dumps(
        {
            "line_items": {
                key: {"value": 1.0, "document_id": 1, "document_location_id": 999999}
                for key in uw.SPREAD_TEMPLATE_KEYS
            }
        }
    )
    assert uw.parse_spread_reply(bogus, locations=locations) is None


def test_spread_reply_parser_rejects_a_hallucinated_value_on_a_real_citation():
    """A real citation to this deal's own location does not excuse a number
    that the cited text does not actually contain — money is never taken on
    an LLM's word alone."""
    locations = _locations_from(FINANCIALS_TEXT)
    revenue_loc = next(loc for loc in locations if loc["extracted_text"].lower().startswith("revenue"))
    hallucinated = json.dumps(
        {
            "line_items": {
                key: (
                    {"value": 999.0, "document_id": 1, "document_location_id": revenue_loc["id"]}
                    if key == "revenue"
                    else "not supported by the record"
                )
                for key in uw.SPREAD_TEMPLATE_KEYS
            }
        }
    )
    assert uw.parse_spread_reply(hallucinated, locations=locations) is None


def test_spread_reply_parser_accepts_a_value_that_matches_its_cited_text():
    # Build directly from the deterministic extraction so the fixture and the
    # parser agree on which location backs which template line.
    locations = _locations_from(FINANCIALS_TEXT)
    derived_items, _ = uw.derive_spread(locations)
    payload = {}
    for item in derived_items:
        if item["supported"]:
            payload[item["line_item_key"]] = {
                "value": item["value"],
                "document_id": item["citation"]["document_id"],
                "document_location_id": item["citation"]["document_location_id"],
            }
        else:
            payload[item["line_item_key"]] = "not supported by the record"
    grounded = json.dumps({"line_items": payload})
    parsed = uw.parse_spread_reply(grounded, locations=locations)
    assert parsed is not None
    for key, expected in EXPECTED_VALUES.items():
        assert parsed[key]["value"] == expected


# ---------------------------------------------------------------- HTTP flow


def test_spread_endpoint_requires_document_extraction_stage():
    _submit({"deal_reference": "T-SPREAD-EARLY"})
    early = client.post("/deals/T-SPREAD-EARLY/spread", json={"acting_user": "an.chen"})
    assert early.status_code == 409


def test_spread_drafts_every_template_line_with_citations():
    _advance_to_document_extraction("T-SPREAD-FULL")
    result = client.post("/deals/T-SPREAD-FULL/spread", json={"acting_user": "an.chen"})
    assert result.status_code == 200
    body = result.json()
    assert body["review_status"] == "pending"
    items = {li["line_item_key"]: li for li in body["spread_line_items"]}
    assert set(items) == uw.SPREAD_TEMPLATE_KEYS
    for key, expected in EXPECTED_VALUES.items():
        assert items[key]["value"] == expected
        assert items[key]["citation"]["document_id"] is not None
        assert items[key]["citation"]["document_location_id"] is not None
    assert len(body["citations"]) == len(EXPECTED_VALUES)
    # the deal now sits at the financial_spreading stage while the draft is
    # pending, not still at document_extraction
    deal = client.get("/deals/T-SPREAD-FULL").json()
    assert deal["current_stage"] == "financial_spreading"


def test_spread_agent_runs_exactly_once_when_workflow_already_produced_it():
    """Accepting the triage draft already resumes the workflow through
    route_to_queue and the spread_financials agent node, parking on
    spread_review — that reply IS what /spread adopts, so calling the
    endpoint never re-prompts the agent."""
    _advance_to_document_extraction("T-SPREAD-ONCE")
    deal = uw.find_deal("T-SPREAD-ONCE")
    run_id = deal["workflow_run_id"]
    state = workflow_engine.state(run_id)
    assert state["status"] == "parked"
    assert state["context"]["spread_financials"]["reply"]  # the agent already ran, inside the tick
    before = len([r for r in uw.store.list("agent_runs") if r.get("deal_reference") == "T-SPREAD-ONCE"])
    assert before == 1  # only the adopted triage run has been materialised into agent_runs so far

    first = client.post("/deals/T-SPREAD-ONCE/spread", json={"acting_user": "an.chen"}).json()
    assert first["created"] is True
    after_first = len([r for r in uw.store.list("agent_runs") if r.get("deal_reference") == "T-SPREAD-ONCE"])
    assert after_first == before + 1  # adopted the workflow's own reply — one new run, not a fresh prompt

    second = client.post("/deals/T-SPREAD-ONCE/spread", json={"acting_user": "an.chen"}).json()
    assert second["created"] is False  # same pending draft returned, no re-run
    after_second = len([r for r in uw.store.list("agent_runs") if r.get("deal_reference") == "T-SPREAD-ONCE"])
    assert after_second == after_first


def test_spread_rejection_requires_a_written_reason():
    _advance_to_document_extraction("T-SPREAD-REJECT")
    client.post("/deals/T-SPREAD-REJECT/spread", json={"acting_user": "an.chen"})
    refused = client.post(
        "/deals/T-SPREAD-REJECT/drafts/spread/review", json={"action": "rejected", "acting_user": "an.chen"}
    )
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]
    ok = client.post(
        "/deals/T-SPREAD-REJECT/drafts/spread/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "Debt schedule looks stale."},
    )
    assert ok.status_code == 200
    assert ok.json()["current_stage"] == "financial_spreading"  # rejection never advances


def test_accepting_the_spread_persists_line_items_and_advances_to_risk_grading():
    _advance_to_document_extraction("T-SPREAD-ACCEPT")
    client.post("/deals/T-SPREAD-ACCEPT/spread", json={"acting_user": "an.chen"})
    result = client.post(
        "/deals/T-SPREAD-ACCEPT/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"}
    )
    assert result.status_code == 200
    body = result.json()
    assert body["current_stage"] == "risk_grading"
    deal = uw.find_deal("T-SPREAD-ACCEPT")
    stored_items = uw.spread_line_items_for(deal["id"])
    stored_citations = uw.citations_for(deal["id"])
    assert len(stored_items) == len(uw.SPREAD_TEMPLATE_KEYS)
    assert len(stored_citations) == len(EXPECTED_VALUES)
    values = {row["line_item_key"]: row["value"] for row in stored_items}
    for key, expected in EXPECTED_VALUES.items():
        assert values[key] == expected


def test_spread_with_no_supporting_documents_is_all_not_supported_by_the_record():
    _advance_to_document_extraction("T-SPREAD-EMPTY", documents=[])
    body = client.post("/deals/T-SPREAD-EMPTY/spread", json={"acting_user": "an.chen"}).json()
    assert body["citations"] == []
    assert set(body["unsupported_line_items"]) == uw.SPREAD_TEMPLATE_KEYS
    for item in body["spread_line_items"]:
        assert item["value"] is None
        assert item["note"] == "not supported by the record"


def test_spread_review_denies_a_relationship_manager():
    _advance_to_document_extraction("T-SPREAD-RBAC")
    client.post("/deals/T-SPREAD-RBAC/spread", json={"acting_user": "an.chen"})
    denied = client.post(
        "/deals/T-SPREAD-RBAC/drafts/spread/review", json={"action": "accepted", "acting_user": "rm.rivera"}
    )
    assert denied.status_code == 403


def test_editing_the_spread_applies_a_human_override_with_traceable_citation():
    _advance_to_document_extraction("T-SPREAD-EDIT")
    client.post("/deals/T-SPREAD-EDIT/spread", json={"acting_user": "an.chen"})
    edited = client.post(
        "/deals/T-SPREAD-EDIT/drafts/spread/review",
        json={"action": "edited", "acting_user": "an.chen", "edits": {"line_item_values": {"revenue": 12_500_000}}},
    )
    assert edited.status_code == 200
    body = edited.json()
    items = {li["line_item_key"]: li for li in body["draft"]["spread_line_items"]}
    assert items["revenue"]["value"] == 12_500_000.0
    assert items["revenue"]["citation"]["source_reference"] == "human-edited override by the reviewing analyst"
    deal = uw.find_deal("T-SPREAD-EDIT")
    stored = {row["line_item_key"]: row for row in uw.spread_line_items_for(deal["id"])}
    assert stored["revenue"]["value"] == 12_500_000.0


# ---------------------------------------------------------------- workflow handler


def test_persist_spread_handler_is_registered_and_idempotent():
    _advance_to_document_extraction("T-SPREAD-WF")
    client.post("/deals/T-SPREAD-WF/spread", json={"acting_user": "an.chen"})
    client.post("/deals/T-SPREAD-WF/drafts/spread/review", json={"action": "accepted", "acting_user": "an.chen"})
    deal = uw.find_deal("T-SPREAD-WF")
    first = uw.spread_line_items_for(deal["id"])
    assert first
    context = {"register_deal": {"deal_id": "T-SPREAD-WF"}}
    replayed = uw.handler_persist_spread_line_items(context)
    assert replayed["spread_line_item_ids"] == [r["id"] for r in first]
    assert len(uw.spread_line_items_for(deal["id"])) == len(first)  # no duplicate rows


def test_workflow_definitions_still_structurally_valid():
    assert workflow_engine.validate_definitions() == []


# ---------------------------------------------------------------- Draft Review workspace queue


def test_draft_review_queue_requires_a_known_actor():
    """Deny by default: the cross-deal queue enumerates every deal's drafts
    and borrower details, so an anonymous or unknown caller may not read it."""
    denied = client.get("/drafts")
    assert denied.status_code in (401, 403)
    denied_unknown = client.get("/drafts", params={"acting_user": "nobody.at.all"})
    assert denied_unknown.status_code == 403


def test_draft_review_queue_lists_every_draft_across_deals():
    _advance_to_document_extraction("T-SPREAD-QUEUE")
    client.post("/deals/T-SPREAD-QUEUE/spread", json={"acting_user": "an.chen"})
    queue = client.get("/drafts", params={"acting_user": "co.brennan"}).json()
    refs = {row["deal_reference"] for row in queue}
    assert "T-SPREAD-QUEUE" in refs
    spread_rows = [row for row in queue if row["deal_reference"] == "T-SPREAD-QUEUE" and row["draft_type"] == "spread"]
    assert spread_rows and spread_rows[0]["review_status"] == "pending"
    assert spread_rows[0]["artifact_label"] == "Financial spread"

    filtered = client.get(
        "/drafts", params={"draft_type": "spread", "review_status": "pending", "acting_user": "co.brennan"}
    ).json()
    assert all(row["draft_type"] == "spread" and row["review_status"] == "pending" for row in filtered)

    draft_id = spread_rows[0]["id"]
    single = client.get(f"/drafts/{draft_id}", params={"acting_user": "co.brennan"}).json()
    assert single["draft_type"] == "spread"
    assert single["deal"]["deal_reference"] == "T-SPREAD-QUEUE"
    assert len(single["evidence"]) == len(EXPECTED_VALUES)

    assert client.get("/drafts/999999999", params={"acting_user": "co.brennan"}).status_code == 404
    assert client.get(f"/drafts/{draft_id}").status_code in (401, 403)


# ---------------------------------------------------------------- hardening


def test_generic_table_api_cannot_forge_spread_data():
    """The scaffold's /api/{table} catch-all must not be a path around
    citation validation, acceptance, and the audit row — spread_line_items
    and citations are deal-of-record money data exactly like deals/drafts."""
    for table in ("spread_line_items", "citations"):
        refused = client.post(f"/api/{table}", json={"deal_id": 1, "line_item_key": "revenue", "value": 999999})
        assert refused.status_code == 403, table
