"""row-history module: field-level change trail. See agent-guide."""
from db import store

_SECRET_FIELDS = {"password", "token", "key", "secret"}


def track(table, row_id, before, after, actor="system"):
    changes = []
    for field in set(before) | set(after):
        if field in _SECRET_FIELDS or field == "id":
            continue
        if before.get(field) != after.get(field):
            changes.append({"field": field, "from": before.get(field), "to": after.get(field)})
    if changes:
        store.insert("_row_history", {"table": table, "row_id": row_id, "actor": actor, "changes": changes})
    return changes


def history(table, row_id):
    return [h for h in store.list("_row_history") if h["table"] == table and h["row_id"] == row_id]
