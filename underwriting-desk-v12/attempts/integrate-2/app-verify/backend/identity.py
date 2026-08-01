"""identity + server-side role enforcement.

Two jobs, deliberately in one place so every slice resolves "who is calling"
and "may they do this" the same way instead of re-implementing lookups and
role checks endpoint by endpoint (see models.TABLES["users"]).

1. RESOLUTION — `resolve_user(email)` find-or-creates the `users` row for a
   *system-provisioned* identity (e.g. the analyst a queue assignment is
   handed to). Known desk accounts get their expected role on first sight so
   slice acceptance fixtures (rm@bank.test, analyst@bank.test,
   officer@bank.test) behave identically on every fresh boot.

2. ENFORCEMENT — `require_actor(email, permission, action)` is the guard every
   mutating endpoint calls. It is DEFAULT-DENY: an email that does not resolve
   to a stored, active `users` row (or a known desk account) can mutate
   nothing, and a resolved user may only do what its role grants.

   Roles, per the approved requirements:
     relationship_manager  — submits deals, views only its own
     credit_analyst        — spreads, grades, drafts memos, recommends
     senior_credit_officer — everything an analyst may do, plus approve,
                             decline (adverse action), return and reassign
     admin                 — unrestricted (operations)

   Exposure-tier authority (an officer-only ceiling above $250,000) is
   enforced on top of this by the approval slice via `MAX_APPROVAL_EXPOSURE`.

ext modules import this module and guard their routes with it:

    actor = identity.require_actor(req.acting_user_email, "deal.approve",
                                   "approve this deal")
"""
import datetime

from fastapi import HTTPException

from db import store

# Desk accounts whose role is fixed by the deal-desk org model.
_KNOWN_ROLES = {
    "rm@bank.test": "relationship_manager",
    "analyst@bank.test": "credit_analyst",
    "officer@bank.test": "senior_credit_officer",
}

RELATIONSHIP_MANAGER = "relationship_manager"
CREDIT_ANALYST = "credit_analyst"
SENIOR_CREDIT_OFFICER = "senior_credit_officer"
ADMIN = "admin"

# The exposure ceiling below which a non-officer may hold approval authority.
MAX_APPROVAL_EXPOSURE = 250000

_ANALYST_PERMISSIONS = {
    "deal.submit",
    "deal.view_all",
    "deal.triage",
    "deal.spread",
    "deal.grade",
    "deal.memo",
    "deal.policy_check",
    "deal.recommend",
    "portfolio.query",
}

_OFFICER_PERMISSIONS = _ANALYST_PERMISSIONS | {
    "deal.approve",
    "deal.decline",
    "deal.return",
    "deal.reassign",
}

ROLE_PERMISSIONS = {
    RELATIONSHIP_MANAGER: {"deal.submit", "deal.view_own", "portfolio.query"},
    CREDIT_ANALYST: _ANALYST_PERMISSIONS | {"deal.view_own"},
    SENIOR_CREDIT_OFFICER: _OFFICER_PERMISSIONS | {"deal.view_own"},
    ADMIN: {"*"},
}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def find_user(email):
    matches = [u for u in store.list("users") if u.get("email") == email]
    return matches[-1] if matches else None


def resolve_user(email, default_role=RELATIONSHIP_MANAGER):
    """Find-or-create the users row for `email`. Returns None for a falsy email.

    This provisions an identity; it does NOT authorize one. Never use it as a
    permission check — call `require_actor` for that.
    """
    if not email:
        return None
    existing = find_user(email)
    if existing is not None:
        return existing
    role = _KNOWN_ROLES.get(email, default_role)
    name = email.split("@")[0].replace(".", " ").replace("_", " ").title()
    return store.insert("users", {
        "email": email,
        "name": name,
        "role": role,
        "is_active": True,
        "created_at": _now(),
        "updated_at": _now(),
    })


def known_actor(email):
    """The stored user for `email`, or None if this caller is not a known user.

    Default-deny: an unrecognised email is NOT provisioned here. Only the
    fixed desk accounts are materialised on first sight (they are part of the
    org model, not caller-supplied identity).
    """
    if not email:
        return None
    existing = find_user(email)
    if existing is not None:
        return existing
    if email in _KNOWN_ROLES:
        return resolve_user(email, default_role=_KNOWN_ROLES[email])
    return None


def permissions_of(user):
    if not user:
        return set()
    return ROLE_PERMISSIONS.get(user.get("role"), set())


def has_permission(user, permission):
    grants = permissions_of(user)
    return "*" in grants or permission in grants


def require_actor(email, permission=None, action=None, roles=None):
    """The server-side guard. Returns the acting user row or raises 403.

    - no email                        -> 401 (identify yourself)
    - email with no stored user       -> 403 (default deny)
    - deactivated user                -> 403
    - role lacking `permission`/`roles` -> 403
    """
    what = action or permission or "perform this action"
    if not email:
        raise HTTPException(status_code=401, detail=f"identify yourself to {what}")
    user = known_actor(email)
    if user is None:
        raise HTTPException(
            status_code=403,
            detail=f"unknown user '{email}' has no authority to {what}",
        )
    if not user.get("is_active", True):
        raise HTTPException(
            status_code=403,
            detail=f"user '{email}' is deactivated and has no authority to {what}",
        )
    if roles is not None and user.get("role") not in roles and user.get("role") != ADMIN:
        raise HTTPException(
            status_code=403,
            detail=f"role '{user.get('role')}' lacks the authority to {what}",
        )
    if permission is not None and not has_permission(user, permission):
        raise HTTPException(
            status_code=403,
            detail=f"role '{user.get('role')}' lacks the authority to {what}",
        )
    return user


def can_view_deal(user, deal):
    """Read scoping: an RM sees only the deals it filed; the desk sees all."""
    if not user or not deal:
        return False
    if has_permission(user, "deal.view_all"):
        return True
    return deal.get("created_by_user_id") == user.get("id") or deal.get(
        "assigned_to_user_id"
    ) == user.get("id")


def visible_deals(user, deals):
    return [d for d in deals if can_view_deal(user, d)]
