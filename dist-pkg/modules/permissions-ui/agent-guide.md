# permissions-ui — agent guide

Renders role management into an element with id="admin-permissions"
when present (designs opt in by including it). Uses textContent only. Data
flows through /admin/roles with the caller's bearer token — the module never
stores tokens itself.
