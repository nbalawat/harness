import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
import sanitizer  # noqa: E402


def test_control_chars_stripped_and_whitespace_collapsed():
    assert sanitizer.clean("hel\x00lo   wor\x1fld\n") == "hello world"


def test_length_cap_is_loud():
    with pytest.raises(sanitizer.InputTooLong):
        sanitizer.clean("x" * 50, max_len=10)


def test_html_escaped():
    assert sanitizer.escape_html('<img onerror="x">') == "&lt;img onerror=&quot;x&quot;&gt;"
