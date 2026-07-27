"""cache-layer module: TTL read-through cache. See agent-guide."""
import functools
import time

_now = time.monotonic
_stores = {}


def cached(ttl_seconds):
    def deco(fn):
        entries = {}
        _stores[fn.__name__] = entries

        @functools.wraps(fn)
        def wrapper(*args):
            hit = entries.get(args)
            if hit and _now() - hit[0] < ttl_seconds:
                return hit[1]
            value = fn(*args)
            entries[args] = (_now(), value)
            return value

        wrapper._cache_name = fn.__name__
        return wrapper

    return deco


def invalidate(fn):
    _stores.get(getattr(fn, "_cache_name", fn if isinstance(fn, str) else fn.__name__), {}).clear()
