"""TEMPORARY merge simulation — deleted before commit."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

import deals_repo  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_sim_merged_book_with_tiered_approval_deals():
    # Simulate sibling slices' seeded book: several deals parked at other stages.
    for name in ("Sim Alpha", "Sim Beta", "Sim Gamma"):
        r = client.post("/api/deals", json={
            "borrower_name": name, "borrower_industry": "trucking",
            "requested_amount": 300000, "exposure_amount": 300000,
            "acting_user_email": "rm@bank.test"})
        deals_repo.update_deal(r.json()["deal_code"], current_stage="tiered_approval")

    # Plus a dozen more at intake, so any top-k would bite.
    for i in range(12):
        client.post("/api/deals", json={
            "borrower_name": f"Sim Filler {i}", "borrower_industry": "retail",
            "requested_amount": 100000 + i, "exposure_amount": 100000 + i,
            "acting_user_email": "rm@bank.test"})

    deal = client.post("/api/deals", json={
        "borrower_name": "Grounding Fixture Freight", "borrower_industry": "trucking",
        "requested_amount": 512000, "exposure_amount": 512000,
        "acting_user_email": "rm@bank.test"}).json()

    board = client.get("/api/pipeline").json()["columns"]
    at_intake = {d["deal_code"] for d in board.get("intake", [])}
    at_tier = {d["deal_code"] for d in board.get("tiered_approval", [])}
    assert len(at_intake) > 8 and len(at_tier) == 3

    b = client.post("/api/qa/ask", json={
        "question": "Which deals are sitting in intake?",
        "acting_user_email": "officer@bank.test"}).json()
    assert set(b["source_deal_ids"]) == at_intake, b["source_deal_ids"]
    assert deal["deal_code"] in b["answer"]

    t = client.post("/api/qa/ask", json={
        "question": "Which deals await tiered approval?",
        "acting_user_email": "officer@bank.test"}).json()
    assert set(t["source_deal_ids"]) == at_tier, t["source_deal_ids"]

    n = client.post("/api/qa/ask", json={
        "question": "What is the status of Grounding Fixture Freight?",
        "acting_user_email": "officer@bank.test"}).json()
    assert deal["deal_code"] in n["source_deal_ids"]
    assert "$512,000" in n["answer"]
