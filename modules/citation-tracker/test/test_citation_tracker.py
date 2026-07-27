import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import citations  # noqa: E402


def test_grounded_render_carries_markers_and_sources():
    cited = citations.attach("Resets happen in the console.", [{"doc_id": "faq.md", "text": "Password resets..."}])
    out = citations.render(cited)
    assert "[1]" in out and "faq.md" in out


def test_ungrounded_is_disclosed_never_hidden():
    out = citations.render(citations.attach("I think so.", []))
    assert "not grounded" in out
