# health-plus — agent guide

/health stays a cheap liveness ping; /healthz is readiness: it
exercises the store (write+read) and reports the agent engine mode. Register
app-specific checks with health_plus.register(name, fn) — fn returns
(ok, detail) and must be fast (<100ms) and side-effect-light.
