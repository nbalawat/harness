"""deals repository: event-sourced reads over db.store's 'deals' rows.

persistence-core (db.py) only supports insert/list — there is no update-in-
place. So `deals` rows are append-only: an "update" is a fresh insert that
carries the deal's human-readable `deal_code` forward. The current state of a
deal is its most recently inserted row for that code. Read/write through
get_deal() / all_current_deals() / update_deal() rather than calling
db.store.list("deals") directly so every slice agrees on what "current" means.

deal_code (e.g. "DEAL-1001") is distinct from the store's internal integer
`id` (db.store.insert always overwrites "id" with its own global counter, so
it cannot hold a human-readable code). next_deal_code() hands out codes from
a dedicated sequence starting at DEAL-1001, independent of any fixture/seed
deals a later slice inserts directly with an explicit deal_code.
"""
import datetime

from db import store


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def next_deal_code():
    store.insert("_deal_code_seq", {})
    return f"DEAL-{1000 + len(store.list('_deal_code_seq'))}"


def get_deal(deal_code):
    rows = [r for r in store.list("deals") if r.get("deal_code") == deal_code]
    return rows[-1] if rows else None


def all_current_deals():
    """Every deal's latest row, in first-seen order."""
    latest = {}
    for r in store.list("deals"):
        latest[r.get("deal_code")] = r
    return list(latest.values())


def create_deal(fields):
    deal_code = next_deal_code()
    row = dict(fields)
    row["deal_code"] = deal_code
    row.setdefault("created_at", _now())
    row.setdefault("updated_at", row["created_at"])
    return store.insert("deals", row)


def update_deal(deal_code, **changes):
    current = get_deal(deal_code)
    if current is None:
        raise KeyError(f"no deal {deal_code}")
    updated = dict(current)
    updated.pop("id", None)
    updated.update(changes)
    updated["deal_code"] = deal_code
    updated["updated_at"] = _now()
    return store.insert("deals", updated)
