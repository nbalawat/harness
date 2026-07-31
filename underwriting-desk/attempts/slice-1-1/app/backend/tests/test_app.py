"""Test harness generated FIRST (before any agent builds) — agents build until green."""
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"  # tests are deterministic by contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_chat_roundtrip():
    response = client.post("/chat", json={"message": "hello"})
    assert response.status_code == 200
    assert response.json()["reply"]


def test_table_crud():
    # Generic catch-all CRUD sanity check against a domain table with no
    # dedicated router (policy_rules) — deals/pipeline/auth have their own
    # specific endpoints exercised below, registered ahead of the catch-all.
    created = client.post("/api/policy_rules", json={"rule_name": "r1"})
    assert created.status_code == 200
    rows = client.get("/api/policy_rules").json()
    assert any(row["rule_name"] == "r1" for row in rows)


def test_unknown_table_404():
    assert client.get("/api/definitely-not-a-table").status_code == 404


def test_login_returns_role():
    resp = client.post("/api/auth/login", json={"username": "rm1", "password": "demo1234"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "relationship_manager"
    assert body["user_id"] == "user-rm1"


def test_login_rejects_bad_password():
    resp = client.post("/api/auth/login", json={"username": "rm1", "password": "wrong"})
    assert resp.status_code == 401


def test_create_deal_at_intake_and_pipeline_board():
    created = client.post(
        "/api/deals",
        json={
            "borrower_name": "Test Fabrication LLC",
            "borrower_industry": "manufacturing",
            "facility_type": "term_loan",
            "requested_amount": 100000,
            "exposure_amount": 100000,
            "submitted_by_user_id": "user-rm1",
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["current_stage"] == "intake"
    assert body["borrower_name"] == "Test Fabrication LLC"

    listed = client.get("/api/deals").json()
    assert any(d["borrower_name"] == "Test Fabrication LLC" for d in listed)

    board = client.get("/api/pipeline").json()
    keys = [s["key"] for s in board["stages"]]
    assert "intake" in keys and "document_extraction" in keys and "approval" in keys
    intake_stage = next(s for s in board["stages"] if s["key"] == "intake")
    assert any(d["borrower_name"] == "Test Fabrication LLC" for d in intake_stage["deals"])


def test_create_deal_rejects_non_rm_submitter():
    resp = client.post(
        "/api/deals",
        json={
            "borrower_name": "Rejected LLC",
            "borrower_industry": "manufacturing",
            "facility_type": "term_loan",
            "requested_amount": 50000,
            "exposure_amount": 50000,
            "submitted_by_user_id": "user-analyst1",
        },
    )
    assert resp.status_code == 403


def test_deals_scoped_to_relationship_manager():
    client.post(
        "/api/deals",
        json={
            "borrower_name": "Scope Check LLC",
            "borrower_industry": "manufacturing",
            "facility_type": "term_loan",
            "requested_amount": 75000,
            "exposure_amount": 75000,
            "submitted_by_user_id": "user-rm1",
        },
    )
    scoped = client.get("/api/deals", params={"as_user_id": "user-rm1"}).json()
    assert all(d["submitted_by_user_id"] == "user-rm1" for d in scoped)
    assert any(d["borrower_name"] == "Scope Check LLC" for d in scoped)


def test_agent_mode_endpoint():
    body = client.get("/agent/mode").json()
    assert body["mode"] == "stub"
    assert "detail" in body


def test_agents_roster_visible():
    """Transparency contract: the app must disclose its configured agents."""
    body = client.get("/agents").json()
    assert isinstance(body["agents"], list) and body["agents"]
    first = body["agents"][0]
    assert first["name"] and first["role"]
