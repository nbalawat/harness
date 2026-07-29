import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from search_index import Index  # noqa: E402


def test_ranking_is_frequency_then_stable():
    ix = Index()
    ix.add("doc-a", "reset password reset token")
    ix.add("doc-b", "reset the router")
    results = ix.search("reset")
    assert [r["id"] for r in results] == ["doc-a", "doc-b"], "higher term frequency ranks first"


def test_empty_and_unknown_queries():
    ix = Index()
    ix.add("doc-a", "hello world")
    assert ix.search("zebra") == []
