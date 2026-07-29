import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import drafts  # noqa: E402
import pytest  # noqa: E402


def test_readers_never_see_unpublished_work():
    drafts.save("welcome", "v1 draft")
    assert drafts.current("welcome") is None, "unpublished content invisible"
    drafts.publish("welcome")
    assert drafts.current("welcome") == "v1 draft"

    drafts.save("welcome", "v2 in progress")
    assert drafts.current("welcome") == "v1 draft", "draft edits don't leak"
    drafts.publish("welcome")
    assert drafts.current("welcome") == "v2 in progress" and drafts.versions("welcome") == 2


def test_publish_without_draft_raises():
    with pytest.raises(KeyError):
        drafts.publish("never-drafted")
