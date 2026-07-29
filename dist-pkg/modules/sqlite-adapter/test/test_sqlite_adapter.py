import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlite_store import SqliteStore  # noqa: E402


def test_roundtrip_and_durability(tmp_path):
    db = tmp_path / "app.db"
    s = SqliteStore(str(db))
    row = s.insert("conversations", {"user": "u1"})
    assert row["id"] >= 1
    s.close()
    s2 = SqliteStore(str(db))
    assert [r["user"] for r in s2.list("conversations")] == ["u1"], "rows survive reconnect"


def test_tables_are_isolated(tmp_path):
    s = SqliteStore(str(tmp_path / "a.db"))
    s.insert("a", {"v": 1})
    assert s.list("b") == []
