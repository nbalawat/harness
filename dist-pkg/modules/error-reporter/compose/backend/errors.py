"""error-reporter module: grouped exception capture. See agent-guide."""
import traceback

from db import store


def capture(exc, context=None):
    tb = traceback.extract_tb(exc.__traceback__)
    location = f"{tb[-1].filename.split('/')[-1]}:{tb[-1].lineno}" if tb else "unknown"
    key = f"{type(exc).__name__}@{location}"
    for row in store.list("_error_groups"):
        if row["key"] == key:
            row["count"] += 1
            row["last_context"] = context or {}
            return row
    return store.insert("_error_groups", {"key": key, "message": str(exc)[:200], "count": 1, "last_context": context or {}})
