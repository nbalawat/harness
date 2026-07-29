import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rbac  # noqa: E402
import rls  # noqa: E402

ROWS = [{"id": 1, "user": "ana"}, {"id": 2, "user": "bob"}]
POLICY = {"owner_field": "user", "bypass_roles": ["admin"]}


def test_owners_see_only_their_rows():
    assert [r["id"] for r in rls.scope(ROWS, "ana", POLICY)] == [1]


def test_admin_bypasses_and_anonymous_sees_nothing():
    rbac.grant("boss", "admin")
    assert len(rls.scope(ROWS, "boss", POLICY)) == 2
    assert rls.scope(ROWS, None, POLICY) == []
