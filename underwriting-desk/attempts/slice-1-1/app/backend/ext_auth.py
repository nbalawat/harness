"""auth-basic module (extended for role-assigned demo accounts, REQ-001).

The certified data model ships a `users` table with a role and a password
hash, and REQ-001 requires the RM/analyst/officer roles to authenticate with
their own account — so this app's identity is password-checked against
`db.store` rather than the module's default password-less v0 behaviour. The
contract stays the same for callers: resolve identity from the
`Authorization: Bearer <token>` header via `current_user()`.

Demo accounts (seeded once, idempotently, on import):
  rm1 / demo1234       -> relationship_manager   (id: user-rm1)
  analyst1 / demo1234  -> credit_analyst          (id: user-analyst1)
  officer1 / demo1234  -> senior_credit_officer   (id: user-officer1)
"""
import hashlib
import secrets

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import rbac
from db import store
from ext_audit import record as audit

router = APIRouter(prefix="/api")

_sessions: dict[str, dict] = {}  # token -> {"user_id", "username", "role"}

_DEMO_PASSWORD = "demo1234"
_SEED_USERS = [
    {"id": "user-rm1", "username": "rm1", "role": "relationship_manager"},
    {"id": "user-analyst1", "username": "analyst1", "role": "credit_analyst"},
    {"id": "user-officer1", "username": "officer1", "role": "senior_credit_officer"},
]


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _seed_users():
    existing = {u["username"] for u in store.list("users")}
    for spec in _SEED_USERS:
        if spec["username"] in existing:
            rbac.grant(spec["username"], spec["role"])
            rbac.grant(spec["id"], spec["role"])
            continue
        row = store.insert(
            "users",
            {
                "username": spec["username"],
                "email": f"{spec['username']}@underwriting-command.example",
                "password_hash": _hash_password(_DEMO_PASSWORD),
                "role": spec["role"],
                "is_active": True,
                "created_at": "2026-01-01T00:00:00Z",
            },
        )
        row["id"] = spec["id"]  # stable business id — see db.store note on custom ids
        rbac.grant(spec["username"], spec["role"])
        rbac.grant(spec["id"], spec["role"])


_seed_users()


def find_user(user_id_or_username: str) -> dict | None:
    for u in store.list("users"):
        if u["id"] == user_id_or_username or u["username"] == user_id_or_username:
            return u
    return None


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
def login(req: LoginRequest):
    username = req.username.strip()
    user = next((u for u in store.list("users") if u["username"] == username), None)
    if user is None or not user.get("is_active", True) or user["password_hash"] != _hash_password(req.password):
        audit("user.login_failed", {"username": username})
        raise HTTPException(status_code=401, detail="invalid username or password")
    token = secrets.token_hex(16)
    _sessions[token] = {"user_id": user["id"], "username": user["username"], "role": user["role"]}
    rbac.grant(user["username"], user["role"])
    rbac.grant(user["id"], user["role"])
    audit("user.login", {"user_id": user["id"], "username": user["username"], "role": user["role"]})
    return {"token": token, "username": user["username"], "user_id": user["id"], "role": user["role"]}


def current_session(authorization: str | None) -> dict | None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    return _sessions.get(token)


def current_user(authorization: str | None) -> str | None:
    session = current_session(authorization)
    return session["username"] if session else None


@router.get("/auth/me")
def me(authorization: str | None = Header(default=None)):
    session = current_session(authorization)
    if session is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return session
