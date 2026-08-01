"""versioned-drafts module: draft/publish content. See agent-guide."""
from db import store


def save(key, content):
    return store.insert("_drafts", {"key": key, "content": content, "state": "draft"})


def publish(key):
    latest = draft(key)
    if latest is None:
        raise KeyError(f"nothing to publish for '{key}'")
    store.insert("_drafts", {"key": key, "content": latest["content"], "state": "published"})
    return latest["content"]


def _all(key):
    return [r for r in store.list("_drafts") if r["key"] == key]


def draft(key):
    entries = [r for r in _all(key) if r["state"] == "draft"]
    return entries[-1] if entries else None


def current(key):
    entries = [r for r in _all(key) if r["state"] == "published"]
    return entries[-1]["content"] if entries else None


def versions(key):
    return len([r for r in _all(key) if r["state"] == "published"])
