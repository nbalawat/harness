"""api-keys module: hashed machine credentials. See agent-guide."""
import hashlib
import secrets as _secrets

_keys: dict[str, dict] = {}


def _hash(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def issue(name):
    secret = "ak_" + _secrets.token_hex(20)
    _keys[name] = {"hash": _hash(secret), "revoked": False, "last_used": None}
    return secret


def verify(secret):
    if not secret:
        return None
    h = _hash(secret)
    for name, rec in _keys.items():
        if rec["hash"] == h and not rec["revoked"]:
            rec["last_used"] = True
            return name
    return None


def revoke(name):
    if name in _keys:
        _keys[name]["revoked"] = True
        return True
    return False
