"""webhook-out module: signed, recorded event delivery. See agent-guide."""
import hashlib
import hmac
import json

import http_client
from db import store


def subscribe(event, url, secret):
    return store.insert("_webhook_subs", {"event": event, "url": url, "secret": secret})


def sign(secret, body: bytes):
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def emit(event, payload, transport=None):
    deliveries = []
    body = json.dumps({"event": event, "payload": payload}).encode()
    for sub in [s for s in store.list("_webhook_subs") if s["event"] == event]:
        headers = {"X-Hook-Signature": sign(sub["secret"], body)}
        try:
            result = http_client.request("POST", sub["url"], json={"event": event, "payload": payload}, headers=headers, transport=transport, retries=1, sleep=lambda _: None)
            status = result["status"]
        except Exception as e:
            status = f"failed: {str(e)[:80]}"
        deliveries.append(store.insert("_webhook_outbox", {"event": event, "url": sub["url"], "status": status}))
    return deliveries
