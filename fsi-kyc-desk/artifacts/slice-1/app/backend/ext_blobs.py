"""blob-store endpoints."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

import blob_store

router = APIRouter()


@router.put("/files/{name}")
async def upload(name: str, request: Request):
    data = await request.body()
    try:
        stored = blob_store.save(name, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"name": stored, "bytes": len(data)}


@router.get("/files/{name}")
def download(name: str):
    try:
        return Response(blob_store.get(name), media_type="application/octet-stream")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no such file")
