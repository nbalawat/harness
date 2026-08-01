"""feedback-inbox module: end-user feedback capture. See agent-guide."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
_entries: list[dict] = []


class FeedbackRequest(BaseModel):
    message: str
    page: str | None = None


@router.post("/feedback")  # public-endpoint: anonymous end-user feedback capture (no identity by design)
def add(req: FeedbackRequest):
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message required")
    entry = {"id": len(_entries) + 1, "message": message, "page": req.page}
    _entries.append(entry)
    return entry


@router.get("/feedback")
def list_feedback():
    return list(reversed(_entries))
