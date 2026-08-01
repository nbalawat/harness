"""file-upload module: guarded intake for user files. See agent-guide.

Identity-guarded: an upload is a mutation, so the caller must identify itself
with an `x-user-email` header that resolves to a known, active user through
the app's identity layer. The body is raw bytes, so identity cannot ride in it
— a missing header is a 401 and an unknown caller is denied by default (403)
— see identity.require_actor.
"""
import os

from fastapi import APIRouter, Header, HTTPException, Request

import blob_store
import ext_audit
import identity

router = APIRouter()


def _allowed_exts():
    return set((os.environ.get("APP_UPLOAD_EXTS") or "txt,md,csv,pdf,docx,png").split(","))


@router.put("/uploads/{name}")
async def upload(
    name: str,
    request: Request,
    x_user_email: str | None = Header(default=None),
):
    if not x_user_email:
        raise HTTPException(status_code=401, detail="x-user-email header required for uploads")
    actor = identity.require_actor(x_user_email, action="upload a file")
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
    return {"name": stored, "bytes": len(data), "uploaded_by": x_user_email}
