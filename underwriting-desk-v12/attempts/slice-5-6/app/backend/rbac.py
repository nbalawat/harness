"""rbac module: declarative roles. See agent-guide."""
from fastapi import HTTPException

_grants: dict[str, set] = {}


def grant(user, role):
    _grants.setdefault(user, set()).add(role)


def revoke(user, role):
    _grants.get(user, set()).discard(role)


def roles_of(user):
    return sorted(_grants.get(user, set()))


def has_role(user, role):
    return role in _grants.get(user, set())


def require(user, role):
    if user is None or not has_role(user, role):
        raise HTTPException(status_code=403, detail=f"requires role '{role}'")
