import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import consent  # noqa: E402
from db import store  # noqa: E402


def test_grant_check_withdraw_history_preserved():
    consent.grant("jane", "support-history")
    assert consent.check("jane", "support-history") is True
    consent.withdraw("jane", "support-history")
    assert consent.check("jane", "support-history") is False
    history = [r["action"] for r in store.list("_consents") if r["subject"] == "jane"]
    assert history == ["grant", "withdraw"], "withdrawal appends, never erases"


def test_unknown_subject_is_false():
    assert consent.check("nobody", "anything") is False
