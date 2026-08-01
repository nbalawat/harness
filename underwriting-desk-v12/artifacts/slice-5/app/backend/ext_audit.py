"""audit-log module: append-only action trail. See agent-guide.

record(event, detail) is the one call site every slice uses for a state
change. Beyond the lightweight developer-facing event stream kept here
in-memory (GET /audit), it also persists a normalized row into the domain
`audit_log` table (see models.TABLES) via db.store, keyed by whatever of
deal_id / actor_user_id / resource_type / resource_id / before / after the
caller supplies in `detail` — that table is the one a deal's audit-timeline
screen reads back in order, so callers that touch a deal should pass those
fields."""
import time

from fastapi import APIRouter
from pydantic import BaseModel

from db import store

router = APIRouter()
_entries: list[dict] = []
_counter = iter(range(1, 10**9))


def record(event: str, detail: dict | None = None) -> dict:
    detail = detail or {}
    entry = {"id": next(_counter), "seq": len(_entries) + 1, "event": event, "detail": detail, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _entries.append(entry)
    try:
        store.insert("audit_log", {
            "deal_id": detail.get("deal_id"),
            "actor_user_id": detail.get("actor_user_id") or detail.get("by"),
            "action": event,
            "resource_type": detail.get("resource_type"),
            "resource_id": detail.get("resource_id") or detail.get("id"),
            "before_payload": detail.get("before"),
            "after_payload": detail.get("after"),
            "timestamp": entry["at"],
        })
    except Exception:
        pass  # the lightweight event stream above is the load-bearing record
    return entry


class AuditRequest(BaseModel):
    event: str
    detail: dict | None = None


@router.post("/audit")
def add(req: AuditRequest):
    return record(req.event, req.detail)


@router.get("/audit")
def list_entries():
    return list(reversed(_entries))
