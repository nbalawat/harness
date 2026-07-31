"""audit-log module: append-only action trail (REQ-018).

Persists through db.store into the certified `audit_log` table (not a
private in-memory list) so the trail is queryable per-deal and exportable —
REQ-047/REQ-050 (examiner filter + CSV export) read this same table. Every
endpoint that changes state calls `record(event_type, detail)`; pass
deal_id/actor_user_id either as explicit kwargs or inside `detail` — record()
lifts them onto the row's first-class columns so per-deal filtering never has
to reach into the free-form `details` blob.
"""
import time

from fastapi import APIRouter
from pydantic import BaseModel

from db import store

router = APIRouter()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def record(
    event_type: str,
    detail: dict | None = None,
    *,
    deal_id=None,
    entity_type: str | None = None,
    entity_id=None,
    actor_user_id: str | None = None,
    action: str | None = None,
    old_values: dict | None = None,
    new_values: dict | None = None,
) -> dict:
    detail = detail or {}
    return store.insert(
        "audit_log",
        {
            "deal_id": deal_id if deal_id is not None else detail.get("deal_id"),
            "event_type": event_type,
            "entity_type": entity_type or detail.get("entity_type"),
            "entity_id": entity_id if entity_id is not None else detail.get("entity_id"),
            "actor_user_id": actor_user_id or detail.get("actor_user_id") or detail.get("by"),
            "action": action or detail.get("action"),
            "old_values": old_values,
            "new_values": new_values,
            "details": detail,
            "created_at": _now(),
        },
    )


class AuditRequest(BaseModel):
    event: str
    detail: dict | None = None


@router.post("/audit")
def add(req: AuditRequest):
    return record(req.event, req.detail)


@router.get("/audit")
def list_entries():
    return list(reversed(store.list("audit_log")))
