"""postgres-adapter module: the persistence-core contract on Postgres."""
import json


class PgStore:
    """Store over any DB-API connection (psycopg in production)."""

    def __init__(self, conn):
        self._conn = conn
        cur = self._conn.cursor()
        cur.execute("CREATE TABLE IF NOT EXISTS app_rows (id SERIAL PRIMARY KEY, tbl TEXT, body JSONB)")
        self._conn.commit()

    def insert(self, table, row):
        row = dict(row)
        cur = self._conn.cursor()
        cur.execute("INSERT INTO app_rows (tbl, body) VALUES (%s, %s) RETURNING id", (table, json.dumps(row)))
        row["id"] = cur.fetchone()[0]
        cur.execute("UPDATE app_rows SET body = %s WHERE id = %s", (json.dumps(row), row["id"]))
        self._conn.commit()
        return row

    def save(self, table, row):
        cur = self._conn.cursor()
        cur.execute("UPDATE app_rows SET body = %s WHERE id = %s AND tbl = %s", (json.dumps(row), row["id"], table))
        if cur.rowcount == 0:
            raise KeyError(f"no row {row.get('id')} in '{table}'")
        self._conn.commit()
        return row

    def list(self, table):
        cur = self._conn.cursor()
        cur.execute("SELECT body FROM app_rows WHERE tbl = %s ORDER BY id", (table,))
        return [r[0] if isinstance(r[0], dict) else json.loads(r[0]) for r in cur.fetchall()]
