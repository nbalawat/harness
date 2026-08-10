# usage-beacon — agent guide

Add `compose/backend/ext_usage.py` to a produced app to record WHO USES it — the
app-popularity signal. It auto-mounts via `main.py`'s `ext_*.install(app)` hook:
a request middleware tallies unique callers per day and periodically POSTs rollups
to the collector (`/v1/app-usage`), which serves per-app unique users, DAU/MAU, and
request volume.

Privacy & safety: the caller identity is HASHED (sha256) before it ever leaves the
app — the platform sees pseudonymous user keys, not raw emails. Health/liveness
paths are ignored so probes don't inflate counts. Reporting is fire-and-forget; a
slow or down collector never affects the app. It is a silent no-op unless
HARNESS_COLLECTOR_URL and HARNESS_APP_ID are set, so cloud/telemetry stays optional.
Requires an auth module (sso-oidc / auth-basic) upstream for real identities;
otherwise it falls back to the client host.
