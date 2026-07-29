"""usage-analytics module: local feature usage. See agent-guide."""
import time
from collections import defaultdict

from fastapi import APIRouter

router = APIRouter()
_daily = defaultdict(int)
_labels = {}


def label(path_prefix, name):
    _labels[path_prefix] = name


def _feature(path):
    for prefix, name in sorted(_labels.items(), key=lambda kv: -len(kv[0])):
        if path.startswith(prefix):
            return name
    return path


def install(app):
    @app.middleware("http")
    async def count_usage(request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith(("/metrics", "/admin/usage", "/health")):
            day = time.strftime("%Y-%m-%d", time.gmtime())
            _daily[(day, _feature(request.url.path))] += 1
        return response


@router.get("/admin/usage")
def usage():
    out = defaultdict(dict)
    for (day, feature), count in sorted(_daily.items()):
        out[day][feature] = count
    return out
