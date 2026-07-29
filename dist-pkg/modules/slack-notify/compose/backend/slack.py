"""slack-notify module: one notification path. See agent-guide."""
import os

import http_client
from db import store


def notify(channel, text, transport=None):
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        return store.insert("_slack_outbox", {"channel": channel, "text": str(text)[:500], "delivered": False})
    http_client.request("POST", url, json={"channel": channel, "text": str(text)[:500]}, transport=transport, retries=1, sleep=lambda _: None)
    return store.insert("_slack_outbox", {"channel": channel, "text": str(text)[:500], "delivered": True})
