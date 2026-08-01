"""search-index endpoint."""
from fastapi import APIRouter

from search_index import index

router = APIRouter()


@router.get("/search")
def search(q: str = ""):
    return index.search(q) if q.strip() else []
