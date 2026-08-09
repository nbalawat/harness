"""persistence-core module (v0): the storage contract behind one `store`.

The interface IS the contract (insert/list). By default the store is in-memory
so tests, certification, and a bare `uvicorn` run need nothing external. When a
DATABASE_URL is present (the Docker Compose / production runtime), the SAME
contract is served by the Postgres adapter — the local-to-production step is a
compose choice, not a rewrite. Do not hand-roll storage elsewhere in the app.
"""
import itertools
import os


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

    def get(self, table, row_id):
        """Fetch one row by id, or None."""
        for r in self._rows.get(table, []):
            if r.get("id") == row_id:
                return r
        return None

    def update(self, table, row_id, changes):
        """Persist a change to an existing row and return it (or None if absent).
        This is the CORRECT way to change stored state: it works identically on
        the in-memory Store and the Postgres adapter. Mutating a row returned by
        list()/get() in place happens to work in memory but persists NOTHING
        through the Postgres adapter (list() there returns fresh dicts) — so it
        is a production data-loss bug the in-memory tests cannot see. Always
        update() through the store."""
        for r in self._rows.get(table, []):
            if r.get("id") == row_id:
                r.update({k: v for k, v in changes.items() if k != "id"})
                return r
        return None


def _make_store():
    """In-memory by default; Postgres when the runtime injects DATABASE_URL and
    the postgres-adapter is composed. Any failure falls back to in-memory so the
    app still boots (degraded, never dead)."""
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        try:
            import psycopg  # provided in the runtime image
            from pg_store import PgStore  # provided by postgres-adapter

            return PgStore(psycopg.connect(dsn))
        except Exception:  # pragma: no cover - depends on runtime wiring
            pass
    return Store()


store = _make_store()
