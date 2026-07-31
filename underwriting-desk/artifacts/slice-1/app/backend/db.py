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

    def save(self, table, row):
        """Persist changes to an existing row.

        The v0 store hands out live row references, so callers *appear* to be
        able to mutate a row in place — an adapter that rebuilds rows from the
        database (see pg_store) would silently drop those writes. Every update
        goes through here so the contract holds under either backend.
        """
        rows = self._rows.setdefault(table, [])
        for existing in rows:
            if existing.get("id") == row.get("id"):
                existing.update(row)
                return existing
        raise KeyError(f"no row {row.get('id')} in '{table}'")

    def list(self, table):
        return list(self._rows.get(table, []))


store = Store()
