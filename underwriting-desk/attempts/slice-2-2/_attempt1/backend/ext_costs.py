"""cost-meter admin endpoint."""
from fastapi import APIRouter

import costmeter

router = APIRouter()


@router.get("/admin/costs")
def costs():
    return costmeter.totals()
