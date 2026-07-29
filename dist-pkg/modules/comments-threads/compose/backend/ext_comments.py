"""comments-threads module: uniform record discussion. See agent-guide."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sanitizer
from db import store

router = APIRouter()


class CommentRequest(BaseModel):
    author: str
    text: str


@router.post("/comments/{table}/{record_id}")
def add(table: str, record_id: int, req: CommentRequest):
    try:
        text = sanitizer.clean(req.text, max_len=2000)
    except sanitizer.InputTooLong as e:
        raise HTTPException(status_code=413, detail=str(e))
    if not text:
        raise HTTPException(status_code=400, detail="empty comment")
    return store.insert("_comments", {"table": table, "record_id": record_id, "author": req.author, "text": text})


@router.get("/comments/{table}/{record_id}")
def list_comments(table: str, record_id: int):
    return [c for c in store.list("_comments") if c["table"] == table and c["record_id"] == record_id]
