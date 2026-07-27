import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import feed_poller  # noqa: E402
from db import store  # noqa: E402


def test_change_detection_by_content_hash():
    calls = []

    def fetcher(url):
        calls.append(url)
        return "same body"

    first = feed_poller.poll("https://x/feed", store, fetcher)
    second = feed_poller.poll("https://x/feed", store, fetcher)
    assert first["changed"] is True and second["changed"] is False
    assert len(calls) == 2, "always fetches, ingests once"

    third = feed_poller.poll("https://x/feed", store, lambda u: "new body")
    assert third["changed"] is True
