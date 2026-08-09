"""audit-log module: append-only action trail. See agent-guide.

Audit rows are written SERVER-SIDE via record() at each mutation, with the
server-resolved actor — there is deliberately NO public write endpoint, so a
caller can never forge an entry or spoof the actor from a request body. The read
endpoint is a sensitive cross-case trail, so it is gated by the app's identity
layer when one is present (soft dependency: the module stays usable standalone).
"""
import time

from fastapi import APIRouter, Query

router = APIRouter()
_entries: list[dict] = []
_counter = iter(range(1, 10**9))

try:  # the app's identity layer, when composed — /audit is a sensitive read
    from identity import require_actor as _require_actor
except Exception:  # standalone module / no identity layer
    _require_actor = None


def record(event: str, detail: dict | None = None, actor: str = "system") -> dict:
    """Write an audit row. The ONLY way to create an entry — callers pass the
    SERVER-RESOLVED actor; there is no request-body actor to forge."""
    entry = {"id": next(_counter), "seq": len(_entries) + 1, "event": event, "actor": actor, "detail": detail or {}, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _entries.append(entry)
    return entry


@router.get("/audit")
def list_entries(acting_user_email: str | None = Query(default=None)):
    # The action trail exposes cross-case actors, ids, and decisions — gate it
    # behind identity when the app provides one (fail closed on absent/unknown).
    if _require_actor is not None:
        _require_actor(acting_user_email)
    return list(reversed(_entries))
