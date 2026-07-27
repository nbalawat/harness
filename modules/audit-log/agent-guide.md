# audit-log — agent guide

Every endpoint that CHANGES state must call
`from ext_audit import record; record("<event>", {...detail})` — approvals,
deletions, sends, config changes. Reads don't need auditing. Never delete or
rewrite audit entries; the trail is append-only by contract.
