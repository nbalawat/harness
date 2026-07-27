# cache-layer — agent guide

Wrap expensive reads with @cached(ttl). ALWAYS call invalidate(fn)
from every write path that changes what fn reads — a stale cache is worse than
no cache. Never cache per-user data without the user in the key args.
