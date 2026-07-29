import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backup  # noqa: E402
import pytest  # noqa: E402
from db import Store, store  # noqa: E402


def test_dump_then_restore_into_fresh_store(tmp_path):
    store.insert("conversations", {"user": "backup-me"})
    path = backup.dump(["conversations"], str(tmp_path / "snap.json"))

    fresh = Store()
    counts = backup.restore(path, fresh)
    assert counts["conversations"] >= 1
    assert any(r["user"] == "backup-me" for r in fresh.list("conversations"))


def test_unknown_format_rejected(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"format": 99, "tables": {}}')
    with pytest.raises(ValueError):
        backup.restore(str(bad), Store())
