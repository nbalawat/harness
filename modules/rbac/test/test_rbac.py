import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rbac  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def login(name):
    return client.post("/auth/login", json={"username": name}).json()["token"]


def test_admin_grants_and_non_admin_is_403():
    rbac.grant("root", "admin")
    admin_token = login("root")
    r = client.post("/admin/roles", json={"user": "ana", "role": "approver"}, headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200 and "approver" in r.json()["roles"]

    peon_token = login("peon")
    assert client.post("/admin/roles", json={"user": "x", "role": "admin"}, headers={"Authorization": f"Bearer {peon_token}"}).status_code == 403


def test_require_raises_for_missing_role():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        rbac.require("nobody", "approver")
