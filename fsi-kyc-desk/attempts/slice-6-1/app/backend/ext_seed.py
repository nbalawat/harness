"""seed-data module: gated deterministic fixtures. See agent-guide."""
import os

from fastapi import APIRouter, HTTPException

from db import store

router = APIRouter()

SEEDS = {
    "conversations": [
        {"user": "demo-analyst", "created_at": "2026-01-05T09:00:00Z"},
        {"user": "demo-lead", "created_at": "2026-01-06T10:30:00Z"},
    ],
}


@router.post("/admin/seed")
def seed():
    if os.environ.get("APP_ALLOW_SEED") != "1":
        raise HTTPException(status_code=403, detail="seeding disabled (set APP_ALLOW_SEED=1 in dev only)")
    if any(r.get("marker") == "seeded" for r in store.list("_seed_state")):
        return {"seeded": False, "reason": "already seeded"}
    counts = {}
    for table, rows in SEEDS.items():
        for row in rows:
            store.insert(table, dict(row))
        counts[table] = len(rows)
    store.insert("_seed_state", {"marker": "seeded"})
    return {"seeded": True, "counts": counts}
