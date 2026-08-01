"""audit-log module: append-only action trail. See agent-guide."""
import time

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()
_entries: list[dict] = []
_counter = iter(range(1, 10**9))


def record(event: str, detail: dict | None = None, actor: str = "system") -> dict:
    entry = {"id": next(_counter), "seq": len(_entries) + 1, "event": event, "actor": actor, "detail": detail or {}, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _entries.append(entry)
    return entry


class AuditRequest(BaseModel):
    event: str
    actor: str  # who did it — an audit entry without an actor is not evidence
    detail: dict | None = None


@router.post("/audit")
def add(req: AuditRequest):
    return record(req.event, req.detail, actor=req.actor)


@router.get("/audit")
def list_entries():
    return list(reversed(_entries))
