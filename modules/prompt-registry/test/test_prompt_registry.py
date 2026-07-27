import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import prompts  # noqa: E402
import pytest  # noqa: E402


def test_latest_version_wins_and_renders():
    prompts.register("draft", "Answer about $topic briefly.", version=1)
    prompts.register("draft", "Answer about $topic with citations.", version=2)
    assert prompts.get("draft")["version"] == 2
    assert prompts.render("draft", topic="refunds") == "Answer about refunds with citations."


def test_missing_variable_fails_loud():
    prompts.register("strict", "Requires $thing.", version=1)
    with pytest.raises(KeyError):
        prompts.render("strict")


def test_unknown_prompt_fails():
    with pytest.raises(KeyError):
        prompts.get("never-registered")
