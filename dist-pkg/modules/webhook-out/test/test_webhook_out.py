import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import webhooks  # noqa: E402
from db import store  # noqa: E402


def test_emit_signs_delivers_and_records():
    webhooks.subscribe("approval.approved", "https://partner/hook", "s3cret")
    seen = {}

    def transport(method, url, body, headers, timeout):
        seen.update({"url": url, "sig": headers.get("X-Hook-Signature"), "body": body})
        return 200, "ok"

    deliveries = webhooks.emit("approval.approved", {"id": 1}, transport=transport)
    assert seen["url"] == "https://partner/hook"
    assert seen["sig"] == webhooks.sign("s3cret", seen["body"]), "verifiable HMAC signature"
    assert deliveries[0]["status"] == 200


def test_failures_stay_visible_in_outbox():
    webhooks.subscribe("thing.happened", "https://down/hook", "k")

    def transport(*a):
        raise ConnectionError("refused")

    webhooks.emit("thing.happened", {}, transport=transport)
    outbox = [o for o in store.list("_webhook_outbox") if o["event"] == "thing.happened"]
    assert outbox and str(outbox[-1]["status"]).startswith("failed")
