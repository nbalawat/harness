"""request-metrics module: uniform ops surface. See agent-guide."""
import time
from collections import defaultdict

from fastapi.responses import PlainTextResponse

_counts = defaultdict(int)
_latency_ms = defaultdict(list)


class _Counter:
    def __init__(self, name):
        self.name = name

    def inc(self, n=1):
        _counts[self.name] += n


def counter(name):
    return _Counter(name)


def install(app):
    @app.middleware("http")
    async def measure(request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        path = request.url.path.split("?")[0]
        _counts[f'http_requests_total{{path="{path}",status="{response.status_code}"}}'] += 1
        _latency_ms[path].append((time.monotonic() - start) * 1000)
        return response

    @app.get("/metrics")
    def metrics():
        lines = [f"{name} {value}" for name, value in sorted(_counts.items())]
        for path, samples in sorted(_latency_ms.items()):
            avg = sum(samples) / len(samples)
            lines.append(f'http_request_latency_ms_avg{{path="{path}"}} {avg:.2f}')
        return PlainTextResponse("\n".join(lines) + "\n")
