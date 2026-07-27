import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cache  # noqa: E402


def test_hit_expiry_and_invalidate(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(cache, "_now", lambda: clock[0])
    calls = []

    @cache.cached(ttl_seconds=10)
    def load(key):
        calls.append(key)
        return f"value-{key}-{len(calls)}"

    assert load("a") == "value-a-1"
    assert load("a") == "value-a-1", "cache hit"
    clock[0] = 11
    assert load("a") == "value-a-2", "expired after ttl"
    cache.invalidate(load)
    assert load("a") == "value-a-3", "invalidate clears"
