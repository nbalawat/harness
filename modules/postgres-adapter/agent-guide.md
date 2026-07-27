# postgres-adapter — agent guide

The production data layer. The connection is INJECTED (duck-typed
DB-API), so app code never builds DSNs — env-config owns that. The SQL this
adapter emits is the contract tested in certification; never bypass it with
raw SQL in endpoints.
