"""blob-store endpoints.

Writes are identity-guarded: PUT /files/{name} is a mutation, so the caller
must identify itself with an `x-user-email` header (or an `acting_user_email`
query parameter) that resolves to a known, active user via the app's identity
layer. Unknown callers are denied by default — see identity.require_actor.
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

import blob_store
import ext_audit
import identity

router = APIRouter()


def _acting_email(request: Request) -> str | None:
    return request.headers.get("x-user-email") or request.query_params.get("acting_user_email")


@router.put("/files/{name}")
async def upload(name: str, request: Request):
    actor = identity.require_actor(_acting_email(request), action="upload a file")
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
    return {"name": stored, "bytes": len(data)}


@router.get("/files/{name}")
def download(name: str):
    try:
        return Response(blob_store.get(name), media_type="application/octet-stream")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no such file")
