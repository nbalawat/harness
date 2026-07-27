"""persistence-core module (v0): in-memory store with a table registry.

The interface is the contract: the Wave-1 Postgres adapter replaces this file
without touching callers. Do not hand-roll storage elsewhere in the app.
"""
import itertools


class Store:
    def __init__(self):
        self._rows = {}
        self._ids = itertools.count(1)

    def insert(self, table, row):
        row = dict(row)
        row["id"] = next(self._ids)
        self._rows.setdefault(table, []).append(row)
        return row

    def list(self, table):
        return list(self._rows.get(table, []))

    def update(self, table, row_id, **changes):
        """Mutate an existing row in place (e.g. recording an approval decision
        on the drafts row) and return it, or None if no row has that id."""
        for row in self._rows.get(table, []):
            if row.get("id") == row_id:
                row.update(changes)
                return row
        return None


store = Store()
