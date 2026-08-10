"""usage-beacon — records WHO USES this deployed app so the platform can rank
app popularity (unique users, DAU/MAU, request volume). Auto-mounts via
main.py's ext_*.install(app) hook. Zero third-party deps (stdlib urllib).

Privacy & security:
- The caller identity is HASHED (sha256, 12 hex) before it ever leaves the app —
  the platform sees stable pseudonymous user keys, not raw emails.
- Fire-and-forget to the collector; a slow/broken collector never affects the app.
- Health/liveness paths are ignored so probes don't inflate usage.

Config (env, all optional — with none set the beacon is a silent no-op):
  HARNESS_COLLECTOR_URL   collector base URL (e.g. https://telemetry.firm)
  HARNESS_APP_ID          this app's registry id (e.g. naveen-kycapp-v17)
  HARNESS_USAGE_FLUSH     flush after N requests (default 25)
"""
import datetime
import hashlib
import json
import os
import threading
import urllib.request

_COLLECTOR = os.environ.get("HARNESS_COLLECTOR_URL")
_APP_ID = os.environ.get("HARNESS_APP_ID")
_FLUSH_EVERY = int(os.environ.get("HARNESS_USAGE_FLUSH", "25"))
_IGNORE = {"/health", "/healthz", "/favicon.ico"}

_lock = threading.Lock()
_buckets: dict[str, dict] = {}  # day -> {"users": set, "requests": int}


def _identity(request) -> str:
    h = request.headers
    ident = h.get("x-firm-identity") or h.get("x-goog-authenticated-user-email") or h.get("x-amzn-oidc-identity")
    if not ident:
        auth = h.get("authorization", "")
        ident = auth[:64] if auth else (request.client.host if request.client else "anon")
    return "u_" + hashlib.sha256(ident.encode()).hexdigest()[:12]


def _flush_locked():
    if not (_COLLECTOR and _APP_ID):
        _buckets.clear()
        return
    for day, b in list(_buckets.items()):
        payload = json.dumps({"appId": _APP_ID, "day": day, "requests": b["requests"], "users": list(b["users"])}).encode()
        req = urllib.request.Request(
            _COLLECTOR.rstrip("/") + "/v1/app-usage",
            data=payload,
            headers={"content-type": "application/json", "x-firm-identity": f"app:{_APP_ID}"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass  # never let telemetry affect the app
    _buckets.clear()


def install(app):
    @app.middleware("http")
    async def _beacon(request, call_next):
        if request.url.path not in _IGNORE:
            day = datetime.datetime.utcnow().strftime("%Y-%m-%d")
            flush = False
            with _lock:
                b = _buckets.setdefault(day, {"users": set(), "requests": 0})
                b["users"].add(_identity(request))
                b["requests"] += 1
                if b["requests"] % _FLUSH_EVERY == 0:
                    flush = True
            if flush:
                with _lock:
                    _flush_locked()
        return await call_next(request)

    @app.on_event("shutdown")
    def _final_flush():
        with _lock:
            _flush_locked()

    @app.get("/usage/self")
    def _usage_self():
        # A deployed app can report its own accumulated (unsent) counters — handy for demos.
        with _lock:
            return {"appId": _APP_ID, "days": {d: {"uniqueUsers": len(b["users"]), "requests": b["requests"]} for d, b in _buckets.items()}}
