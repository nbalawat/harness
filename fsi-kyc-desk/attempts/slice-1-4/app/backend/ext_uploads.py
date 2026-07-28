"""file-upload module: guarded intake for user files. See agent-guide."""
import os

from fastapi import APIRouter, HTTPException, Request

import blob_store

router = APIRouter()


def _allowed_exts():
    return set((os.environ.get("APP_UPLOAD_EXTS") or "txt,md,csv,pdf,docx,png").split(","))


@router.put("/uploads/{name}")
async def upload(name: str, request: Request):
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
    return {"name": stored, "bytes": len(data)}
