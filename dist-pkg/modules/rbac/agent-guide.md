# rbac — agent guide

Protect endpoints with rbac.require(username, "approver") — it raises
403 as an HTTPException. Roles are granted through /admin/roles (admin only),
never hardcoded per user in code. Check roles at the endpoint boundary, not
deep in helpers, so the permission surface stays auditable.
