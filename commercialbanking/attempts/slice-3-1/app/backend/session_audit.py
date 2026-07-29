"""session-audit module: identity events into the audit trail. See agent-guide."""
from ext_audit import record


def login(user):
    return record("session.login", {"user": user})


def logout(user):
    return record("session.logout", {"user": user})


def denied(user, what):
    return record("session.denied", {"user": user or "anonymous", "what": what})
