"""blob-store endpoints.

Writes are identity-guarded: PUT /files/{name} is a mutation, so the caller
must identify itself with an `x-user-email` header that resolves to a known,
active user via the app's identity layer. The body is raw bytes, so identity
cannot ride in it — a missing header is a 401 and an unknown caller is denied
by default (403) — see identity.require_actor.
"""
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response

import blob_store
import ext_audit
import identity

router = APIRouter()


@router.put("/files/{name}")
async def upload(
    name: str,
    request: Request,
    x_user_email: str | None = Header(default=None),
):
    if not x_user_email:
        raise HTTPException(status_code=401, detail="x-user-email header required for uploads")
    actor = identity.require_actor(x_user_email, action="upload a file")
    data = await request.body()
    try:
        stored = blob_store.save(name, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ext_audit.record(
        "blob.stored",
        {"actor_user_id": actor.get("email"), "resource_type": "blob", "resource_id": stored,
         "after": {"name": stored, "bytes": len(data)}},
        actor=actor.get("email") or "system",
    )
    return {"name": stored, "bytes": len(data), "uploaded_by": x_user_email}


@router.get("/files/{name}")
def download(name: str):
    try:
        return Response(blob_store.get(name), media_type="application/octet-stream")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no such file")
