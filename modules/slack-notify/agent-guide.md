# slack-notify — agent guide

Notifications go through slack.notify. Without SLACK_WEBHOOK_URL the
message lands in the outbox (visible, testable) instead of vanishing — dev and
prod share one code path. Keep messages short; never include PII (run pii
redaction upstream if text is user-derived).
