import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import store  # noqa: E402
from migrations import apply_all  # noqa: E402


def test_ordered_apply_and_idempotency(tmp_path):
    (tmp_path / "001_seed.py").write_text("def migrate(store):\n    store.insert('conversations', {'user': 'mig'})\n")
    (tmp_path / "002_more.py").write_text("def migrate(store):\n    store.insert('conversations', {'user': 'mig2'})\n")
    first = apply_all(str(tmp_path), store)
    assert first == ["001_seed", "002_more"], "ordered"
    again = apply_all(str(tmp_path), store)
    assert again == [], "idempotent — applied migrations never re-run"
