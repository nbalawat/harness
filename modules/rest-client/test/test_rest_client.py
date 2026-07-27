import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import http_client  # noqa: E402
import pytest  # noqa: E402


def test_retries_5xx_with_backoff_then_succeeds():
    calls, sleeps = [], []

    def transport(method, url, body, headers, timeout):
        calls.append(method)
        return (503, "busy") if len(calls) < 3 else (200, "ok")

    result = http_client.request("GET", "https://x/api", transport=transport, retries=3, sleep=sleeps.append)
    assert result["status"] == 200 and len(calls) == 3
    assert sleeps == [0.1, 0.2], "exponential backoff"


def test_4xx_never_retried():
    calls = []

    def transport(*a):
        calls.append(1)
        return (404, "nope")

    with pytest.raises(http_client.HttpError):
        http_client.request("GET", "https://x/missing", transport=transport, retries=5)
    assert len(calls) == 1
