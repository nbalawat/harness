"""auth-basic module: minimal bearer-token identity. See agent-guide."""
import secrets

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

router = APIRouter()
_sessions: dict[str, str] = {}


class LoginRequest(BaseModel):
    username: str


@router.post("/auth/login")  # public-endpoint: credential exchange is inherently pre-identity
def login(req: LoginRequest):
    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="username required")
    token = secrets.token_hex(16)
    _sessions[token] = username
    return {"token": token, "username": username}


def current_user(authorization: str | None) -> str | None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    return _sessions.get(token)


@router.get("/auth/me")
def me(authorization: str | None = Header(default=None)):
    username = current_user(authorization)
    if username is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return {"username": username}
