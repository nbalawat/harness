import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import slack  # noqa: E402
from db import store  # noqa: E402


def test_outbox_mode_without_webhook(monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    entry = slack.notify("#support", "SLA at risk on ticket 42")
    assert entry["delivered"] is False
    assert any(e["text"].startswith("SLA at risk") for e in store.list("_slack_outbox"))


def test_delivery_mode_uses_transport(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack/x")
    sent = {}

    def transport(method, url, body, headers, timeout):
        sent["url"] = url
        return 200, "ok"

    entry = slack.notify("#support", "resolved", transport=transport)
    assert sent["url"].startswith("https://hooks.slack") and entry["delivered"] is True
