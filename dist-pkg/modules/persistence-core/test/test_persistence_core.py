import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import store  # noqa: E402


def test_insert_assigns_ids_and_lists_roundtrip():
    a = store.insert("conversations", {"user": "u1"})
    b = store.insert("conversations", {"user": "u2"})
    assert b["id"] > a["id"]
    users = [r["user"] for r in store.list("conversations")]
    assert "u1" in users and "u2" in users


def test_insert_copies_input_row():
    original = {"user": "u3"}
    stored = store.insert("conversations", original)
    assert "id" not in original, "caller's dict must not be mutated"
    assert stored["user"] == "u3"


def test_empty_table_lists_empty():
    assert store.list("never-written") == []
