import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rag  # noqa: E402


def test_chunking_respects_sentences_and_size():
    text = "First sentence here. " * 40
    chunks = rag.chunk(text, size=200)
    assert len(chunks) > 1
    assert all(c.endswith(".") for c in chunks), "sentence boundaries preserved"


def test_retrieval_ranks_specific_over_generic():
    ix = rag.Index()
    ix.add("faq", "Password resets are handled in the admin console under user access.")
    ix.add("misc", "The office coffee machine password is rotated monthly for fun.")
    ix.add("other", "Unrelated shipping policies and return windows.")
    top = ix.retrieve("how do I reset a user password", k=2)
    assert top[0]["doc_id"] == "faq"
    assert top[0]["score"] > 0


def test_no_match_returns_empty():
    ix = rag.Index()
    ix.add("a", "hello world")
    assert ix.retrieve("zebra quantum") == []
