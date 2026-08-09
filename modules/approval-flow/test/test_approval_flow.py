import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_full_loop_with_audit_and_double_decision_409():
    item = client.post("/workflow/submissions", json={"kind": "reply", "payload": {"text": "draft"}, "by": "agent"}).json()
    assert item["id"] in [p["id"] for p in client.get("/workflow/submissions/pending").json()]

    # identity is required and attributed (fail-closed if absent)
    ok = client.post(f"/workflow/submissions/{item['id']}/approve", json={"acting_user_email": "ana", "reason": "looks right"})
    assert ok.status_code == 200 and ok.json()["status"] == "approved"

    again = client.post(f"/workflow/submissions/{item['id']}/reject", json={"acting_user_email": "bob"})
    assert again.status_code == 409, "decided items cannot be re-decided"

    events = [e["event"] for e in client.get("/audit").json()]
    assert "workflow.submitted" in events and "workflow.approved" in events


def test_approve_without_identity_is_rejected():
    item = client.post("/workflow/submissions", json={"kind": "reply", "payload": {"text": "d"}, "by": "agent"}).json()
    # missing acting_user_email -> fail closed (401), never an anonymous decision
    assert client.post(f"/workflow/submissions/{item['id']}/approve", json={"reason": "x"}).status_code == 401


def test_unknown_submission_404():
    assert client.post("/workflow/submissions/9999/approve", json={"acting_user_email": "x"}).status_code == 404
