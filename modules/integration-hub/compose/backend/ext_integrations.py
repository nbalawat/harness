"""Expose the integration surface so the app can show which enterprise systems
the process touches (all stubbed, swappable for live connectors)."""
from fastapi import APIRouter
import integrations

router = APIRouter(prefix="/api/integrations")


@router.get("")
def list_connectors():
    return {"connectors": integrations.registered(), "mode": "stubbed"}
