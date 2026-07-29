"""rate-limit module: sliding-window per-client throttle. See agent-guide."""
import os
import time
from collections import defaultdict, deque

from starlette.responses import JSONResponse


def install(app):
    window: dict[str, deque] = defaultdict(deque)

    @app.middleware("http")
    async def throttle(request, call_next):
        limit = int(os.environ.get("APP_RATE_LIMIT", "240"))
        client = request.client.host if request.client else "unknown"
        now = time.monotonic()
        q = window[client]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return JSONResponse({"detail": "rate limit exceeded"}, status_code=429, headers={"Retry-After": "10"})
        q.append(now)
        return await call_next(request)
