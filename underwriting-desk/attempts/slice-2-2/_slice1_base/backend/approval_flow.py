"""approval-flow module: the review loop. See agent-guide."""
from ext_audit import record
from db import store


class IllegalTransition(Exception):
    pass


def submit(kind, payload, submitted_by):
    item = store.insert("_approvals_queue", {"kind": kind, "payload": payload, "status": "pending", "by": submitted_by})
    record("workflow.submitted", {"id": item["id"], "kind": kind})
    return item


def _find(item_id):
    for row in store.list("_approvals_queue"):
        if row["id"] == item_id:
            return row
    return None


def _decide(item_id, actor, decision, reason):
    item = _find(item_id)
    if item is None:
        raise KeyError(f"no submission {item_id}")
    if item["status"] != "pending":
        raise IllegalTransition(f"submission {item_id} is already {item['status']}")
    item["status"] = decision
    item["decided_by"] = actor
    item["reason"] = reason
    # Persist through the store rather than relying on mutating a dict the
    # store happened to hand back: a non-in-memory adapter rebuilds rows on
    # every list(), so an unsaved decision would silently vanish and the gate
    # would read as pending forever.
    store.save("_approvals_queue", item)
    record(f"workflow.{decision}", {"id": item_id, "by": actor, "reason": reason})
    return item


def approve(item_id, actor, reason=""):
    return _decide(item_id, actor, "approved", reason)


def reject(item_id, actor, reason=""):
    return _decide(item_id, actor, "rejected", reason)


def pending():
    return [r for r in store.list("_approvals_queue") if r["status"] == "pending"]
