"""feature-flags module: deterministic rollout. See agent-guide."""
import hashlib

_flags = {}


def enable(name):
    _flags[name] = {"mode": "on"}


def disable(name):
    _flags[name] = {"mode": "off"}


def rollout(name, percent):
    _flags[name] = {"mode": "percent", "percent": max(0, min(100, percent))}


def is_enabled(name, user=None):
    flag = _flags.get(name, {"mode": "off"})
    if flag["mode"] == "on":
        return True
    if flag["mode"] == "off":
        return False
    bucket = int(hashlib.sha256(f"{name}:{user}".encode()).hexdigest(), 16) % 100
    return bucket < flag["percent"]
