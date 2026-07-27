import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcripts  # noqa: E402


def test_append_redacts_at_write_time():
    transcripts.append("c1", "user", "reach me at jane@firm.com or 555-123-4567")
    stored = transcripts.get("c1")[0]["text"]
    assert "jane@firm.com" not in stored and "555-123-4567" not in stored
    assert "[email]" in stored


def test_conversations_isolated():
    transcripts.append("c2", "assistant", "hello")
    assert all(t["conversation_id"] == "c2" for t in transcripts.get("c2"))
