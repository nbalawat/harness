import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_store import PgStore  # noqa: E402


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        self.conn.executed.append((sql.strip().split()[0], params))
        if sql.startswith("INSERT"):
            self.conn.next_id += 1
            self._last = (self.conn.next_id,)
        elif sql.startswith("SELECT"):
            self._rows = [(body,) for body in self.conn.rows]

    def fetchone(self):
        return self._last

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self):
        self.executed, self.rows, self.next_id = [], [], 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass


def test_contract_sql_and_id_assignment():
    conn = FakeConn()
    store = PgStore(conn)
    row = store.insert("conversations", {"user": "u1"})
    assert row["id"] == 1
    verbs = [v for v, _ in conn.executed]
    assert "CREATE" in verbs and "INSERT" in verbs and "UPDATE" in verbs
    assert all(p is None or "%s" not in str(p) for _, p in conn.executed), "parameterized, never interpolated"


def test_list_parses_json_bodies():
    conn = FakeConn()
    store = PgStore(conn)
    conn.rows = ['{"user": "u2", "id": 7}']
    assert store.list("conversations")[0]["user"] == "u2"
