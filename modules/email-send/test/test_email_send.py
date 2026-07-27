import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mailer  # noqa: E402
import pytest  # noqa: E402


def test_template_rendering_and_suppression():
    mailer.register_template("approval", "Approved: $title", "Your item '$title' was approved.")
    sent = mailer.send("ana@firm.com", "approval", {"title": "Q3 report"})
    assert sent["subject"] == "Approved: Q3 report" and sent["status"] == "queued"

    mailer.suppress("Gone@firm.com")
    blocked = mailer.send("gone@firm.com", "approval", {"title": "x"})
    assert blocked["status"] == "suppressed" and "subject" not in blocked, "suppressed mail is never rendered"


def test_unknown_template_fails_loud():
    with pytest.raises(KeyError):
        mailer.send("a@b.c", "never-registered")
