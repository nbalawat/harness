"""Slice 1 — deal intake, triage draft, pipeline board.

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

import underwriting as uw  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

DEAL_1001 = {
    "deal_reference": "T-DEAL-1001",
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
            "text": (
                "FY2025 Audited Financial Statements. Income Statement: Revenue 12,400,000; "
                "EBITDA 1,420,000. Balance Sheet: Current Assets 3,300,000; Total Debt 5,600,000."
            ),
        },
        {
            "document_type": "business_tax_return",
            "original_filename": "1120S-2025.pdf",
            "content_type": "application/pdf",
            "text": "Form 1120S tax year 2025. Gross receipts 12,400,000. Depreciation 620,000.",
        },
    ],
}


def _submit(overrides=None):
    body = dict(DEAL_1001)
    body.update(overrides or {})
    return client.post("/deals", json=body)


# ---------------------------------------------------------------- deterministic units


@pytest.mark.parametrize(
    "amount,tier",
    [(1, "analyst"), (250_000, "analyst"), (250_000.01, "officer"), (780_000, "officer"), (1_000_000, "officer"), (1_000_000.01, "committee"), (3_100_000, "committee")],
)
def test_approval_tier_is_derived_deterministically(amount, tier):
    assert uw.derive_approval_tier(amount) == tier


def test_exposure_is_the_requested_amount_alone():
    assert uw.exposure_for(780000) == 780000.0


def test_canonical_stage_order():
    assert uw.STAGES[0] == "intake"
    assert uw.STAGES[-1] == "closing"
    assert list(uw.STAGES) == [
        "intake",
        "document_extraction",
        "financial_spreading",
        "risk_grading",
        "memo_drafting",
        "policy_compliance",
        "tiered_approval",
        "closing",
    ]


def test_document_split_produces_citable_locations():
    locations = uw.split_into_locations("Income Statement: Revenue 12,400,000; EBITDA 1,420,000.\nBalance Sheet: Total Debt 5,600,000.")
    assert locations
    assert {loc["section"] for loc in locations} == {"Income Statement", "Balance Sheet"}
    assert all(loc["page_number"] >= 1 for loc in locations)


def test_queue_proposal_is_deterministic():
    assert uw.propose_queue("surgical instrument manufacturing")["queue_id"] == "queue-specialty-manufacturing"
    assert uw.propose_queue("artisanal bakery")["queue_id"] == "queue-general-ci"


def test_triage_reply_parser_rejects_out_of_vocabulary_output():
    allowed_docs = set(uw.DOCUMENT_TYPES)
    queues = {q["queue_id"] for q in uw.ANALYST_QUEUES}
    assert uw.parse_triage_reply('{"classification":"made_up","missing_documents":[],"proposed_queue":"queue-general-ci"}', allowed_documents=allowed_docs, allowed_queue_ids=queues) is None
    assert uw.parse_triage_reply('{"classification":"term_loan","missing_documents":["nope"],"proposed_queue":"queue-general-ci"}', allowed_documents=allowed_docs, allowed_queue_ids=queues) is None
    good = uw.parse_triage_reply('{"classification":"term_loan","missing_documents":["debt_schedule"],"proposed_queue":"queue-general-ci","rationale":"x"}', allowed_documents=allowed_docs, allowed_queue_ids=queues)
    assert good["classification"] == "term_loan"


# ---------------------------------------------------------------- intake


def test_submit_creates_deal_at_intake_with_derived_tier():
    body = _submit().json()
    assert body["deal_reference"] == "T-DEAL-1001"
    assert body["current_stage"] == "intake"
    assert body["approval_tier"] == "officer"
    assert body["exposure_amount"] == 780000.0
    assert body["deal"]["document_count"] == 2


def test_submit_is_replay_safe_and_conflicts_on_changed_details():
    first = _submit({"deal_reference": "T-DEAL-REPLAY"})
    assert first.status_code == 200
    again = _submit({"deal_reference": "T-DEAL-REPLAY"})
    assert again.status_code == 200
    assert again.json()["replayed"] is True
    conflict = _submit({"deal_reference": "T-DEAL-REPLAY", "requested_amount": 999})
    assert conflict.status_code == 409


def test_committee_tier_above_one_million():
    body = _submit(
        {
            "deal_reference": "T-DEAL-2001",
            "borrower_name": "Blue Ridge Wellness Dispensary LLC",
            "borrower_industry": "cannabis dispensary",
            "facility_type": "line_of_credit",
            "requested_amount": 3100000,
            "collateral_value": 3900000,
            "documents": [],
        }
    ).json()
    assert body["approval_tier"] == "committee"
    assert body["required_role"] == "credit_committee_chair"
    # advisory-only intake screen; the deal is still accepted at intake
    assert body["preflight"]["prohibited_industry"]["status"] == "flag"
    assert body["current_stage"] == "intake"


def test_submit_rejects_invalid_payloads():
    assert _submit({"deal_reference": "T-BAD-1", "requested_amount": -5}).status_code == 400
    assert _submit({"deal_reference": "T-BAD-2", "facility_type": "unicorn_loan"}).status_code == 400
    assert _submit({"deal_reference": "!!", "borrower_name": "x"}).status_code == 400
    bad_doc = _submit({"deal_reference": "T-BAD-3", "documents": [{"document_type": "mystery", "original_filename": "a.pdf"}]})
    assert bad_doc.status_code == 400


def test_submit_denies_unknown_and_wrongly_roled_actors():
    assert _submit({"deal_reference": "T-DENY-1", "submitted_by": "mallory"}).status_code == 403
    # an analyst may not originate a deal
    assert _submit({"deal_reference": "T-DENY-2", "submitted_by": "an.chen"}).status_code == 403


# ---------------------------------------------------------------- triage


def test_triage_produces_a_pending_draft_and_never_advances_the_deal():
    _submit({"deal_reference": "T-DEAL-TRIAGE"})
    body = client.post("/deals/T-DEAL-TRIAGE/triage", json={"acting_user": "an.chen"}).json()
    assert body["review_status"] == "pending"
    assert body["classification"] in uw.FACILITY_TYPES
    assert body["proposed_queue"] in {q["queue_id"] for q in uw.ANALYST_QUEUES}
    assert "debt_schedule" in body["missing_documents"]
    assert body["agent_run"]["latency_ms"] >= 0
    assert body["agent_run"]["prompt_template_version"] == "intake_triage@v1"
    # the deal has NOT moved: agent output never advances a stage
    assert body["deal"]["current_stage"] == "intake"


def test_triage_is_idempotent_while_a_draft_is_pending():
    _submit({"deal_reference": "T-DEAL-IDEM"})
    first = client.post("/deals/T-DEAL-IDEM/triage", json={"acting_user": "an.chen"}).json()
    second = client.post("/deals/T-DEAL-IDEM/triage", json={"acting_user": "an.chen"}).json()
    assert first["id"] == second["id"]
    assert second["created"] is False


def test_triage_requires_a_known_actor_and_a_known_deal():
    _submit({"deal_reference": "T-DEAL-ACTOR"})
    assert client.post("/deals/T-DEAL-ACTOR/triage", json={"acting_user": "nobody"}).status_code == 403
    assert client.post("/deals/T-NOPE/triage", json={"acting_user": "an.chen"}).status_code == 404


def test_draft_rejection_requires_a_written_reason():
    _submit({"deal_reference": "T-DEAL-REJECT"})
    client.post("/deals/T-DEAL-REJECT/triage", json={"acting_user": "an.chen"})
    refused = client.post("/deals/T-DEAL-REJECT/drafts/triage/review", json={"action": "rejected", "acting_user": "an.chen"})
    assert refused.status_code == 400
    assert "reason" in refused.json()["detail"]
    ok = client.post(
        "/deals/T-DEAL-REJECT/drafts/triage/review",
        json={"action": "rejected", "acting_user": "an.chen", "reason": "Document set is stale."},
    )
    assert ok.status_code == 200
    assert ok.json()["current_stage"] == "intake"  # rejection never advances


def test_accepting_triage_routes_the_deal_and_advances_one_stage():
    _submit({"deal_reference": "T-DEAL-ACCEPT"})
    client.post("/deals/T-DEAL-ACCEPT/triage", json={"acting_user": "an.chen"})
    body = client.post(
        "/deals/T-DEAL-ACCEPT/drafts/triage/review", json={"action": "accepted", "acting_user": "an.chen"}
    ).json()
    assert body["review_action"] == "accepted"
    assert body["reviewed_by_user_id"] == "an.chen"
    assert body["current_stage"] == "document_extraction"
    assert body["promoted"]["assigned_analyst_id"] == "an.chen"


def test_review_denies_a_relationship_manager():
    _submit({"deal_reference": "T-DEAL-RBAC"})
    client.post("/deals/T-DEAL-RBAC/triage", json={"acting_user": "an.chen"})
    denied = client.post(
        "/deals/T-DEAL-RBAC/drafts/triage/review", json={"action": "accepted", "acting_user": "rm.rivera"}
    )
    assert denied.status_code == 403


# ---------------------------------------------------------------- board / audit / workflow


def test_pipeline_board_lists_every_stage_and_active_deals():
    _submit({"deal_reference": "T-DEAL-BOARD"})
    board = client.get("/pipeline").json()
    assert [s["slug"] for s in board["stages"]] == list(uw.STAGES)
    assert any(d["deal_reference"] == "T-DEAL-BOARD" for d in board["deals"])
    assert board["totals"]["live_exposure"] > 0


def test_deals_listing_exposes_current_stage():
    _submit({"deal_reference": "T-DEAL-LIST"})
    rows = client.get("/deals").json()
    match = [r for r in rows if r["deal_reference"] == "T-DEAL-LIST"]
    assert match and match[0]["current_stage"] == "intake"


def test_board_csv_export_includes_the_deal_reference():
    _submit({"deal_reference": "T-DEAL-CSV"})
    response = client.get("/deals/export.csv")
    assert response.status_code == 200
    assert "deal_reference" in response.text
    assert "T-DEAL-CSV" in response.text


def test_every_intake_writes_an_append_only_audit_row():
    _submit({"deal_reference": "T-DEAL-AUDIT"})
    rows = [r for r in uw.store.list("audit_log") if r.get("deal_reference") == "T-DEAL-AUDIT"]
    events = {r["event_type"] for r in rows}
    assert "deal.created" in events
    assert "stage.transition" in events
    assert "document.stored" in events
    assert all(r.get("actor_user_id") for r in rows)


def test_intake_runs_the_approved_workflow_and_parks_on_the_human_node():
    body = _submit({"deal_reference": "T-DEAL-WF"}).json()
    run_id = body["workflow"]["run_id"]
    state = client.get(f"/workflows/runs/{run_id}").json()
    assert state["status"] == "parked"
    assert state["workflow"] == "deal-underwriting"
    assert state["context"]["register_deal"]["deal_id"] == "T-DEAL-WF"
    assert state["context"]["store_documents"]["document_count"] == 2
    assert state["context"]["extract_documents"]["document_location_ids"]
    assert state["context"]["triage"]["reply"]


def test_workflow_definitions_are_structurally_valid():
    assert workflow_problems() == []


def workflow_problems():
    import workflow_engine

    return workflow_engine.validate_definitions()


def test_intake_draft_can_be_saved_and_reloaded():
    saved = client.post(
        "/intake/drafts",
        json={"deal_reference": "T-DEAL-SAVE", "acting_user": "rm.rivera", "content": {"borrower_name": "Draft Co"}},
    )
    assert saved.status_code == 200
    loaded = client.get("/intake/drafts/T-DEAL-SAVE").json()
    assert loaded["content"]["borrower_name"] == "Draft Co"


def test_intake_config_exposes_the_vocabulary_the_ui_binds_to():
    config = client.get("/intake/config").json()
    assert {f["slug"] for f in config["facility_types"]} == set(uw.FACILITY_TYPES)
    assert config["approval_tiers"]["officer_ceiling"] == 1_000_000
    assert {u["username"] for u in config["users"]} >= {"rm.rivera", "an.chen", "co.brennan"}


# ---------------------------------------------------------------- review findings


def test_intake_runs_the_triage_agent_exactly_once():
    """The workflow's own triage node output IS the reviewed draft — the agent
    is not prompted a second time to build it."""
    _submit({"deal_reference": "T-DEAL-ONCE"})
    deal = uw.find_deal("T-DEAL-ONCE")
    runs = [r for r in uw.store.list("agent_runs") if r.get("deal_reference") == "T-DEAL-ONCE"]
    assert len(runs) == 1
    assert runs[0]["inputs"]["workflow_node"] == "triage"
    assert runs[0]["latency_ms"] >= 0 and runs[0]["model_id"]
    body = client.post("/deals/T-DEAL-ONCE/triage", json={"acting_user": "an.chen"}).json()
    assert body["created"] is False  # returns the workflow's draft, no new run
    assert len([r for r in uw.store.list("agent_runs") if r.get("deal_reference") == "T-DEAL-ONCE"]) == 1
    assert uw.pending_draft(deal["id"], "triage")["agent_run_id"] == runs[0]["id"]


def test_accepting_the_draft_resumes_the_approved_workflow():
    """The human decision releases the parked run; route_to_queue then executes."""
    body = _submit({"deal_reference": "T-DEAL-RESUME"}).json()
    run_id = body["workflow"]["run_id"]
    assert client.get(f"/workflows/runs/{run_id}").json()["status"] == "parked"
    client.post("/deals/T-DEAL-RESUME/drafts/triage/review", json={"action": "accepted", "acting_user": "an.chen"})
    state = client.get(f"/workflows/runs/{run_id}").json()
    # the human node published its action, so the acceptance condition matched
    assert state["context"]["triage_review"]["action"] == "accepted"
    assert state["context"]["triage_accepted"]["matched"] is True
    routed = state["context"]["route_to_queue"]
    assert routed["assigned_analyst_id"] == "an.chen"
    assert routed["analyst_queue_id"] and routed["stage_transition_id"]
    assert routed["to_stage"] == "document_extraction"


def test_workflow_agent_nodes_use_the_roster_agent_for_that_node():
    import agent_runtime

    assert agent_runtime.agent_for_node("deal-underwriting", "triage") == "Intake Triage Agent"
    assert agent_runtime.agent_for_node("deal-underwriting", "spread_financials") == "Financial Spreading Agent"
    assert agent_runtime.agent_for_node("credit-approval", "draft_memo") == "Credit Memo Agent"
    assert agent_runtime.agent_for_node("deal-underwriting", "register_deal") is None


def test_state_changes_survive_a_store_that_rebuilds_rows():
    """Updates go through store.save, so an adapter that does not hand out live
    row references (pg_store) keeps them."""
    _submit({"deal_reference": "T-DEAL-PERSIST"})
    client.post(
        "/deals/T-DEAL-PERSIST/drafts/triage/review", json={"action": "accepted", "acting_user": "an.chen"}
    )
    reloaded = [d for d in uw.store.list("deals") if d["deal_reference"] == "T-DEAL-PERSIST"][0]
    assert reloaded["current_stage"] == "document_extraction"
    assert reloaded["assigned_analyst_id"] == "an.chen"
    stored_draft = [d for d in uw.store.list("agent_drafts") if d.get("deal_reference") == "T-DEAL-PERSIST"][-1]
    assert stored_draft["review_status"] == "accepted"


def test_store_save_round_trips_and_rejects_unknown_rows():
    from db import store as raw

    row = raw.insert("_probe", {"value": 1})
    row["value"] = 2
    raw.save("_probe", row)
    assert [r for r in raw.list("_probe") if r["id"] == row["id"]][0]["value"] == 2
    with pytest.raises(KeyError):
        raw.save("_probe", {"id": -1})


def test_a_session_identity_cannot_act_as_someone_else():
    token = client.post("/auth/login", json={"username": "an.chen"}).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    _submit({"deal_reference": "T-DEAL-IMPERSONATE"})
    denied = client.post(
        "/deals/T-DEAL-IMPERSONATE/drafts/triage/review",
        json={"action": "accepted", "acting_user": "co.brennan"},
        headers=headers,
    )
    assert denied.status_code == 403
    allowed = client.post(
        "/deals/T-DEAL-IMPERSONATE/drafts/triage/review",
        json={"action": "accepted", "acting_user": "an.chen"},
        headers=headers,
    )
    assert allowed.status_code == 200
    assert allowed.json()["reviewed_by_user_id"] == "an.chen"


def test_the_full_intake_form_is_captured_and_the_tin_is_masked():
    body = _submit(
        {
            "deal_reference": "T-DEAL-FORM",
            "borrower_dba": "Piedmont Ortho",
            "borrower_tin": "56-2841907",
            "borrower_established": "2012",
            "borrower_address": "4412 Kestrel Ave, Greensboro, NC 27409",
            "collateral_description": "Equipment + blanket UCC-1",
            "term_months": 84,
        }
    ).json()
    deal = body["deal"]
    assert deal["borrower_dba"] == "Piedmont Ortho"
    assert deal["borrower_established"] == "2012"
    assert deal["borrower_address"].startswith("4412 Kestrel")
    assert deal["collateral_description"] == "Equipment + blanket UCC-1"
    assert deal["term_months"] == 84
    assert deal["borrower_tin_masked"] == "***-**1907"
    assert "2841907" not in json.dumps(deal)  # the full TIN is never stored


def test_term_months_is_validated():
    assert _submit({"deal_reference": "T-DEAL-TERM", "term_months": 9999}).status_code == 400


def test_extracted_page_count_is_stable_across_a_replayed_node():
    _submit({"deal_reference": "T-DEAL-PAGES"})
    deal = uw.find_deal("T-DEAL-PAGES")
    context = {"register_deal": {"deal_id": "T-DEAL-PAGES"}, "inputs": {}}
    first = uw.handler_extract_document_locations(context)
    second = uw.handler_extract_document_locations(context)
    assert first["extracted_page_count"] == second["extracted_page_count"] > 0
    assert first["document_location_ids"] == second["document_location_ids"]
    assert uw.documents_for(deal["id"])


def test_store_documents_replay_still_names_an_audit_row():
    _submit({"deal_reference": "T-DEAL-DOCS"})
    context = {"register_deal": {"deal_id": "T-DEAL-DOCS"}, "inputs": {}}
    replayed = uw.handler_store_borrower_documents(context)
    assert replayed["audit_log_id"] is not None
    assert replayed["document_count"] == 2


def test_the_triage_gate_is_not_reused_by_another_draft_type():
    _submit({"deal_reference": "T-DEAL-GATE"})
    deal = uw.find_deal("T-DEAL-GATE")
    triage = uw.pending_draft(deal["id"], "triage")
    gate = uw._human_gate_for(deal, "spread", {"rationale": "x"})
    assert gate["id"] != triage["approval_item_id"]
    assert gate["kind"] == "agent_draft:spread"
