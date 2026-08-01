"""file-upload module: guarded intake for user files. See agent-guide.

Identity-guarded: an upload is a mutation, so the caller must identify itself
with an `x-user-email` header (or an `acting_user_email` query parameter) that
resolves to a known, active user through the app's identity layer. Unknown
callers are denied by default — see identity.require_actor.
"""
import os

from fastapi import APIRouter, HTTPException, Request

import blob_store
import ext_audit
import identity

router = APIRouter()


def _allowed_exts():
    return set((os.environ.get("APP_UPLOAD_EXTS") or "txt,md,csv,pdf,docx,png").split(","))


def _acting_email(request: Request) -> str | None:
    return request.headers.get("x-user-email") or request.query_params.get("acting_user_email")


@router.put("/uploads/{name}")
async def upload(name: str, request: Request):
    actor = identity.require_actor(_acting_email(request), action="upload a file")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _allowed_exts():
        raise HTTPException(status_code=415, detail=f"extension '.{ext}' not allowed")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    try:
        stored = blob_store.save(name, data)
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
    ext_audit.record(
        "upload.stored",
        {"actor_user_id": actor.get("email"), "resource_type": "upload", "resource_id": stored,
         "after": {"name": stored, "bytes": len(data)}},
        actor=actor.get("email") or "system",
    )
    return {"name": stored, "bytes": len(data)}
