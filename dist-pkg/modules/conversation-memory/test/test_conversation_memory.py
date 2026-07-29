import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from convo_memory import Memory  # noqa: E402


def test_recent_turns_verbatim_old_turns_folded():
    m = Memory(max_chars=120)
    for i in range(8):
        m.add("user", f"turn number {i} with some padding text")
    ctx = m.context()
    assert "turn number 7" in ctx, "latest turn verbatim"
    assert "[earlier:" in ctx, "old turns summarized, not dropped silently"
    assert len([line for line in ctx.splitlines() if line.startswith("user:")]) <= 3


def test_small_conversations_untouched():
    m = Memory(max_chars=1000)
    m.add("user", "hello")
    m.add("assistant", "hi")
    assert "[earlier:" not in m.context()
