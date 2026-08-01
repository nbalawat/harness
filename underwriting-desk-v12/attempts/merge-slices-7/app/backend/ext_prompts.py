"""prompt-registry admin endpoint."""
from fastapi import APIRouter

import prompts

router = APIRouter()


@router.get("/admin/prompts")
def list_prompts():
    return prompts.catalog()
