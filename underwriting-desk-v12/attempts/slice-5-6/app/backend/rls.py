"""row-level-security module: ownership scoping. See agent-guide."""
import rbac


def scope(rows, user, policy):
    owner_field = policy.get("owner_field", "user")
    for role in policy.get("bypass_roles", ["admin"]):
        if user is not None and rbac.has_role(user, role):
            return list(rows)
    return [r for r in rows if r.get(owner_field) == user]
