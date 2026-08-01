"""identity resolution: maps an acting-user email to a `users` row, creating
it on first sight. Central place so every slice resolves "who is this
acting_user_email" the same way instead of re-implementing lookups (see
models.TABLES["users"]).

Known desk accounts get their expected role on first sight so slice acceptance
fixtures (rm@bank.test, analyst@bank.test, officer@bank.test) behave the same
in every fresh boot; any other email gets the caller-supplied default role.
"""
import datetime

from db import store

_KNOWN_ROLES = {
    "rm@bank.test": "relationship_manager",
    "analyst@bank.test": "credit_analyst",
    "officer@bank.test": "senior_credit_officer",
}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def find_user(email):
    matches = [u for u in store.list("users") if u.get("email") == email]
    return matches[-1] if matches else None


def resolve_user(email, default_role="relationship_manager"):
    """Find-or-create the users row for `email`. Returns None for a falsy email."""
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
