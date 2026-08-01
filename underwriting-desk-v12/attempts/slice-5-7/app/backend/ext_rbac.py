"""rbac admin endpoints."""
from fastapi import APIRouter, Header
from pydantic import BaseModel

import rbac
from ext_auth import current_user

router = APIRouter()


class GrantRequest(BaseModel):
    user: str
    role: str


@router.post("/admin/roles")
def grant_role(req: GrantRequest, authorization: str | None = Header(default=None)):
    actor = current_user(authorization)
    rbac.require(actor, "admin")
    rbac.grant(req.user, req.role)
    return {"user": req.user, "roles": rbac.roles_of(req.user)}


@router.get("/admin/roles")
def all_roles(authorization: str | None = Header(default=None)):
    actor = current_user(authorization)
    rbac.require(actor, "admin")
    return {u: rbac.roles_of(u) for u in sorted(rbac._grants)}
