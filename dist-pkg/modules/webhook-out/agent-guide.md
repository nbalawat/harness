# webhook-out — agent guide

Emit domain events through webhooks.emit — direct HTTP calls to
partner systems fail review. Deliveries are signed (X-Hook-Signature,
HMAC-SHA256 of the body) and recorded in the outbox with status; failures stay
visible for redelivery. Never emit secrets in payloads.
