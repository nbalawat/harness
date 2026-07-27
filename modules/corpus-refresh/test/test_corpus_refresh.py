import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import corpus_refresh  # noqa: E402


def test_rebuild_swaps_and_reports(tmp_path):
    (tmp_path / "faq.md").write_text("Password resets happen in the admin console.")
    (tmp_path / "junk.xyz").write_text("?")
    report = corpus_refresh.rebuild(str(tmp_path))
    assert report["indexed"] == ["faq.md"]
    assert report["skipped"][0]["file"] == "junk.xyz"
    hits = corpus_refresh.index.retrieve("password reset")
    assert hits and hits[0]["doc_id"] == "faq.md"

    (tmp_path / "faq.md").write_text("Totally different topic now: shipping windows.")
    corpus_refresh.rebuild(str(tmp_path))
    assert corpus_refresh.index.retrieve("password reset") == [], "old index fully replaced"
