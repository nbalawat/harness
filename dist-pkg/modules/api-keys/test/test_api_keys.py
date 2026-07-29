import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_keys  # noqa: E402


def test_issue_verify_revoke_lifecycle():
    secret = api_keys.issue("reporting-job")
    assert secret.startswith("ak_")
    assert api_keys.verify(secret) == "reporting-job"
    assert api_keys.revoke("reporting-job") is True
    assert api_keys.verify(secret) is None, "revoked keys stop working"


def test_only_hash_is_stored():
    secret = api_keys.issue("etl")
    assert all(secret not in str(rec) for rec in api_keys._keys.values()), "raw secret never persisted"


def test_garbage_rejected():
    assert api_keys.verify("nope") is None and api_keys.verify(None) is None
