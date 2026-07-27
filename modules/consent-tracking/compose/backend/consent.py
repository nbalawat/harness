"""consent-tracking module: recorded basis for data holding. See agent-guide."""
from db import store


def grant(subject, purpose, basis="consent"):
    return store.insert("_consents", {"subject": subject, "purpose": purpose, "basis": basis, "action": "grant"})


def withdraw(subject, purpose):
    return store.insert("_consents", {"subject": subject, "purpose": purpose, "action": "withdraw"})


def check(subject, purpose):
    state = False
    for rec in store.list("_consents"):
        if rec["subject"] == subject and rec["purpose"] == purpose:
            state = rec["action"] == "grant"
    return state
