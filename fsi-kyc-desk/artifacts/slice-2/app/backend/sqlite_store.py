"""sqlite-adapter module: durable Store with the persistence-core contract."""
import json
import sqlite3


class SqliteStore:
    def __init__(self, path):
        self._db = sqlite3.connect(path)
        self._db.execute("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, body TEXT)")
        self._db.commit()

    def insert(self, table, row):
        row = dict(row)
        cur = self._db.execute("INSERT INTO rows (tbl, body) VALUES (?, ?)", (table, json.dumps(row)))
        self._db.commit()
        row["id"] = cur.lastrowid
        self._db.execute("UPDATE rows SET body = ? WHERE id = ?", (json.dumps(row), cur.lastrowid))
        self._db.commit()
        return row

    def list(self, table):
        cur = self._db.execute("SELECT body FROM rows WHERE tbl = ? ORDER BY id", (table,))
        return [json.loads(b[0]) for b in cur.fetchall()]

    def close(self):
        self._db.close()
