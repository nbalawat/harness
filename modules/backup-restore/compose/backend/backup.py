"""backup-restore module: dumps with a tested restore path. See agent-guide."""
import json

from db import store as default_store


def dump(tables, path, store=None):
    store = store or default_store
    snapshot = {"format": 1, "tables": {t: store.list(t) for t in tables}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f)
    return path


def restore(path, store):
    with open(path, encoding="utf-8") as f:
        snapshot = json.load(f)
    if snapshot.get("format") != 1:
        raise ValueError("unknown backup format")
    counts = {}
    for table, rows in snapshot["tables"].items():
        for row in rows:
            store.insert(table, {k: v for k, v in row.items() if k != "id"})
        counts[table] = len(rows)
    return counts
