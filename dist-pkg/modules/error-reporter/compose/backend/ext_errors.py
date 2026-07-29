"""error-reporter admin endpoint."""
from fastapi import APIRouter

from db import store

router = APIRouter()


@router.get("/admin/errors")
def groups():
    return sorted(store.list("_error_groups"), key=lambda g: -g["count"])
