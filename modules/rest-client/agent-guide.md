# rest-client — agent guide

ALL outbound HTTP goes through http_client.request — the transport is
injectable (tests pass fakes; production uses the default urllib transport).
Retries apply to 5xx/connection errors only, never to 4xx. Timeouts are
mandatory; there is no infinite default.
