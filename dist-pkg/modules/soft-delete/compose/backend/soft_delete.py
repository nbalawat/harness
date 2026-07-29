"""soft-delete module: uniform deletion policy. See agent-guide."""
import time

from db import store


def delete(table, row_id):
    for row in store.list(table):
        if row["id"] == row_id and not row.get("deleted_at"):
            row["deleted_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            store.insert(f"_{table}_deletions", {"row_id": row_id, "at": row["deleted_at"]})
            return row
    return None


def _deleted_ids(table):
    return {r["row_id"] for r in store.list(f"_{table}_deletions")} - {
        r["row_id"] for r in store.list(f"_{table}_restores")
    }


def active(table):
    dead = _deleted_ids(table)
    return [r for r in store.list(table) if r["id"] not in dead]


def deleted(table):
    dead = _deleted_ids(table)
    return [r for r in store.list(table) if r["id"] in dead]


def restore(table, row_id):
    if row_id in _deleted_ids(table):
        store.insert(f"_{table}_restores", {"row_id": row_id})
        return True
    return False
