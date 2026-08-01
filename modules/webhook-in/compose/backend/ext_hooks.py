"""webhook-in module: verified event intake. See agent-guide."""
import hashlib
import hmac
import os

from fastapi import APIRouter, Header, HTTPException, Request

from db import store

router = APIRouter()


@router.post("/hooks/{name}")  # public-endpoint: external event intake, authenticated by HMAC signature + nonce
async def receive(name: str, request: Request, x_hook_signature: str | None = Header(default=None), x_hook_nonce: str | None = Header(default=None)):
    secret = os.environ.get(f"APP_HOOK_SECRET_{name.upper()}")
    if not secret:
        raise HTTPException(status_code=404, detail="unknown hook")
    body = await request.body()
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if not x_hook_signature or not hmac.compare_digest(expected, x_hook_signature):
        raise HTTPException(status_code=401, detail="bad signature")
    if not x_hook_nonce:
        raise HTTPException(status_code=400, detail="missing nonce")
    if any(e["nonce"] == x_hook_nonce for e in store.list("_hook_events") if e["hook"] == name):
        raise HTTPException(status_code=409, detail="replay")
    return store.insert("_hook_events", {"hook": name, "nonce": x_hook_nonce, "body": body.decode("utf-8", errors="replace")[:5000]})
