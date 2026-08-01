"""Tests for slice `spread-ratios-and-risk-grade`: the cited financial spread,
the deterministic ratios, and the versioned risk-grade rubric.

These tests build their own deals through the public API rather than leaning on
the demonstration dossier, so they hold regardless of what other slices' tests
have already filed.
"""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import ext_spread_ratios_and_risk_grade as spread_mod  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

ANALYST = "analyst@bank.test"

FULL_PACK = [
    ("income_statement", "FY25-P&L.pdf", [
        {"line_item_key": "revenue", "period": "FY2025", "value": 4180000, "unit": "USD",
         "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 4"},
        {"line_item_key": "adjusted_ebitda", "period": "FY2025", "value": 712000, "unit": "USD",
         "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 22"},
        {"line_item_key": "interest_expense", "period": "FY2025", "value": None, "unit": "USD",
         "page_number": 2, "section": "Statement of Operations", "cell_locator": "row 18"},
    ]),
    ("balance_sheet", "BS-FY25.pdf", [
        {"line_item_key": "current_assets", "period": "FY2025", "value": 611000, "unit": "USD",
         "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 9"},
        {"line_item_key": "current_liabilities", "period": "FY2025", "value": 430300, "unit": "USD",
         "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 21"},
        {"line_item_key": "total_funded_debt", "period": "FY2025", "value": 2207000, "unit": "USD",
         "page_number": 1, "section": "Balance Sheet", "cell_locator": "row 27"},
    ]),
    ("tax_return", "TAX-FY24.pdf", [
        {"line_item_key": "annual_debt_service", "period": "FY2025", "value": 574200, "unit": "USD",
         "page_number": 3, "section": "Schedule L", "cell_locator": "row 6"},
    ]),
]


def _new_deal(name="Spread Test Co", amount=640000):
    resp = client.post("/api/deals", json={
        "borrower_name": name,
        "borrower_industry": "ambulatory health services",
        "requested_amount": amount,
        "exposure_amount": amount,
        "acting_user_email": "rm@bank.test",
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["deal_code"]


def _attach(deal_code, pack=FULL_PACK, actor=ANALYST):
    last = None
    for document_type, file_name, figures in pack:
        last = client.post(f"/api/deals/{deal_code}/documents", json={
            "acting_user_email": actor,
            "document_type": document_type,
            "file_name": file_name,
            "figures": figures,
        })
        assert last.status_code == 201, last.text
    return last


def _spread_deal(name="Spread Test Co", amount=640000):
    deal_code = _new_deal(name, amount)
    _attach(deal_code)
    return deal_code


# ----------------------------- documents -----------------------------

def test_attaching_the_pack_reports_completeness():
    deal_code = _new_deal("Docket Co")
    body = _attach(deal_code).json()
    assert body["documents_complete"] is True
    assert body["missing_document_types"] == []


def test_partial_pack_reports_what_is_missing():
    deal_code = _new_deal("Partial Pack Co")
    body = _attach(deal_code, pack=FULL_PACK[:1]).json()
    assert body["documents_complete"] is False
    assert set(body["missing_document_types"]) == {"balance_sheet", "tax_return"}


def test_attaching_a_document_requires_authority():
    deal_code = _new_deal("Guarded Co")
    resp = client.post(f"/api/deals/{deal_code}/documents", json={
        "acting_user_email": "rm@bank.test",  # relationship managers do not spread
        "document_type": "balance_sheet",
        "file_name": "BS.pdf",
        "figures": [],
    })
    assert resp.status_code == 403


# ------------------------- the spreading agent -------------------------

def test_spread_run_cites_every_row_and_omits_the_illegible_line():
    deal_code = _spread_deal("Citation Co")
    body = client.post(
        f"/api/deals/{deal_code}/agents/financial-spreading/run",
        json={"acting_user_email": ANALYST},
    ).json()

    assert body["template_version"] == spread_mod.TEMPLATE_VERSION
    assert body["every_figure_cited"] is True
    cited_keys = {c["line_item_key"] for c in body["citations"]}
    for row in body["rows"]:
        assert row["line_item_key"] in cited_keys
    for citation in body["citations"]:
        assert citation["document_id"]
        assert citation["cell_locator"] or citation["section"] or citation["page_number"] is not None
    # the illegible interest-expense line is reported, never guessed
    unextractable = {u["line_item_key"] for u in body["unextractable"]}
    assert "interest_expense" in unextractable
    assert "interest_expense" not in {r["line_item_key"] for r in body["rows"]}


def test_spread_run_requires_documents():
    deal_code = _new_deal("Paperless Co")
    resp = client.post(
        f"/api/deals/{deal_code}/agents/financial-spreading/run",
        json={"acting_user_email": ANALYST},
    )
    assert resp.status_code == 409


def test_spread_run_requires_authority():
    deal_code = _spread_deal("Unauthorised Co")
    resp = client.post(
        f"/api/deals/{deal_code}/agents/financial-spreading/run",
        json={"acting_user_email": "nobody@bank.test"},
    )
    assert resp.status_code == 403


def test_nothing_reaches_the_template_before_acceptance():
    deal_code = _spread_deal("Unaccepted Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    assert spread_mod.accepted_spread_rows(deal_code) == {}
    assert client.get(f"/api/deals/{deal_code}/ratios").status_code == 409
    assert client.get(f"/api/deals/{deal_code}/risk-grade").status_code == 409


# ---------------------------- human review ----------------------------

def test_accepting_the_spread_records_the_reviewer_and_computes_everything():
    deal_code = _spread_deal("Accepted Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    resp = client.post(f"/api/deals/{deal_code}/spread/accept",
                       json={"acting_user_email": ANALYST, "action": "accept"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["review_action"] == "accepted"
    assert body["reviewed_by"] == ANALYST
    assert body["line_item_count"] == 6
    assert body["risk_grade"]["grade"] == 4


def test_accept_before_a_draft_is_a_conflict():
    deal_code = _spread_deal("Premature Co")
    resp = client.post(f"/api/deals/{deal_code}/spread/accept",
                       json={"acting_user_email": ANALYST, "action": "accept"})
    assert resp.status_code == 409


def test_rejecting_needs_a_written_reason_and_writes_nothing():
    deal_code = _spread_deal("Rejected Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    assert client.post(f"/api/deals/{deal_code}/spread/accept",
                       json={"acting_user_email": ANALYST, "action": "reject"}).status_code == 400
    resp = client.post(f"/api/deals/{deal_code}/spread/accept", json={
        "acting_user_email": ANALYST,
        "action": "reject",
        "rejection_reason": "EBITDA add-backs are not supported by the tax return",
    })
    assert resp.status_code == 200
    assert resp.json()["accepted"] is False
    assert spread_mod.accepted_spread_rows(deal_code) == {}


def test_an_edited_figure_must_still_have_a_cited_source():
    deal_code = _spread_deal("Edited Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    resp = client.post(f"/api/deals/{deal_code}/spread/accept", json={
        "acting_user_email": ANALYST,
        "action": "edit",
        "edited_rows": [{"line_item_key": "goodwill_addback", "period": "FY2025", "value": 99000}],
    })
    assert resp.status_code == 422


def test_editing_a_cited_figure_is_accepted_and_changes_the_grade():
    deal_code = _spread_deal("Regraded Co")
    draft = client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                        json={"acting_user_email": ANALYST}).json()
    edited = [dict(r) for r in draft["rows"]]
    for row in edited:
        if row["line_item_key"] == "adjusted_ebitda":
            row["value"] = 420000  # DSCR falls to 0.73 -> the floor band
    resp = client.post(f"/api/deals/{deal_code}/spread/accept", json={
        "acting_user_email": ANALYST, "action": "edit", "edited_rows": edited,
    })
    assert resp.status_code == 200
    assert resp.json()["review_action"] == "accepted_with_edits"
    assert client.get(f"/api/deals/{deal_code}/risk-grade").json()["grade"] == 8


# --------------------------- deterministic math ---------------------------

def test_ratios_show_their_arithmetic_and_rounding():
    deal_code = _spread_deal("Ratio Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    client.post(f"/api/deals/{deal_code}/spread/accept",
                json={"acting_user_email": ANALYST, "action": "accept"})
    body = client.get(f"/api/deals/{deal_code}/ratios").json()

    assert body["dscr"] == 1.24            # 712,000 / 574,200 half-up to 2dp
    assert body["leverage"] == 3.10        # 2,207,000 / 712,000
    assert body["current_ratio"] == 1.42   # 611,000 / 430,300
    for key in ("dscr", "leverage", "current_ratio"):
        ratio = body["ratios"][key]
        assert ratio["numerator"] and ratio["denominator"]
        assert ratio["rounding_method"] == spread_mod.ROUNDING_METHOD
        assert ratio["divide_by_zero_handling"] == spread_mod.DIVIDE_BY_ZERO_HANDLING


def test_a_zero_denominator_is_undefined_not_an_error():
    deal_code = _spread_deal("Zero Service Co")
    draft = client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                        json={"acting_user_email": ANALYST}).json()
    edited = [dict(r) for r in draft["rows"]]
    for row in edited:
        if row["line_item_key"] == "annual_debt_service":
            row["value"] = 0
    client.post(f"/api/deals/{deal_code}/spread/accept", json={
        "acting_user_email": ANALYST, "action": "edit", "edited_rows": edited,
    })
    body = client.get(f"/api/deals/{deal_code}/ratios").json()
    assert body["dscr"] is None
    assert body["ratios"]["dscr"]["denominator"] == 0
    assert body["leverage"] == 3.10  # the other ratios still compute
    assert client.get(f"/api/deals/{deal_code}/risk-grade").json()["grade"] == 8


def test_risk_grade_prints_the_band_it_struck():
    deal_code = _spread_deal("Graded Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    client.post(f"/api/deals/{deal_code}/spread/accept",
                json={"acting_user_email": ANALYST, "action": "accept"})
    body = client.get(f"/api/deals/{deal_code}/risk-grade").json()

    assert body["grade"] == 4
    assert body["rubric_version"] == spread_mod.RUBRIC_VERSION
    assert "band 4 of 8" in body["band_hit"]
    assert "Watch" in body["band_hit"]
    assert [b for b in body["rubric"] if b["is_band_hit"]][0]["grade"] == 4
    # the grade is carried on the deal itself, so the board can filter on it
    deals = client.get("/api/pipeline").json()["deals"]
    assert [d for d in deals if d["deal_code"] == deal_code][0]["risk_grade"] == 4


# ------------------------- audit + read scoping -------------------------

def test_every_step_leaves_an_audit_trail():
    deal_code = _spread_deal("Audited Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    client.post(f"/api/deals/{deal_code}/spread/accept",
                json={"acting_user_email": ANALYST, "action": "accept"})
    from db import store

    actions = [r["action"] for r in store.list("audit_log") if r.get("deal_id") == deal_code]
    for expected in ("deal.document_attached", "spread.agent_run", "spread.accepted",
                     "ratio.computed", "risk_grade.assigned"):
        assert expected in actions
    assert all(r.get("actor_user_id") for r in store.list("audit_log")
               if r.get("deal_id") == deal_code and r["action"] == "spread.accepted")


def test_dossier_read_is_scoped_to_the_caller():
    deal_code = _spread_deal("Private Co")
    # an identified relationship manager who did not file this deal cannot read it
    import identity as identity_module

    identity_module.resolve_user("other.rm@bank.test", default_role=identity_module.RELATIONSHIP_MANAGER)
    resp = client.get(f"/api/deals/{deal_code}/dossier",
                      params={"acting_user_email": "other.rm@bank.test"})
    assert resp.status_code == 403
    assert client.get(f"/api/deals/{deal_code}/dossier",
                      params={"acting_user_email": ANALYST}).status_code == 200


def test_dossier_assembles_the_whole_screen():
    deal_code = _spread_deal("Dossier Co")
    client.post(f"/api/deals/{deal_code}/agents/financial-spreading/run",
                json={"acting_user_email": ANALYST})
    client.post(f"/api/deals/{deal_code}/spread/accept",
                json={"acting_user_email": ANALYST, "action": "accept"})
    body = client.get(f"/api/deals/{deal_code}/dossier").json()

    assert body["deal"]["deal_code"] == deal_code
    assert len(body["documents"]) == 3
    assert len(body["spread"]["accepted_rows"]) == 6
    assert body["spread"]["accepted_rows"][0]["document_file_name"]
    assert body["ratios"]["dscr"]["result"] == 1.24
    assert body["risk_grade"]["grade"] == 4
    assert body["deal"]["approval_tier"].startswith("senior credit officer")


def test_reserved_demonstration_deal_code_is_never_reallocated():
    codes = {_new_deal(f"Sequence Co {i}") for i in range(4)}
    assert spread_mod.FIXTURE_DEAL_CODE not in codes


def test_workflow_handlers_for_this_slice_are_registered():
    import workflow_engine

    for handler in ("verify_required_documents", "validate_spread_citations",
                    "persist_accepted_spread", "compute_financial_ratios", "assign_risk_grade"):
        assert handler in workflow_engine._handlers
