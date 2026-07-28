"""auth-basic module: minimal bearer-token identity. See agent-guide."""
import secrets

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

router = APIRouter()
_sessions: dict[str, str] = {}


class LoginRequest(BaseModel):
    username: str
    password: str = ""


def _roster_entry(username):
    """slice 4: the credential a login for a NAMED roster account must match.

    Import is local (not at module scope) so this generic auth-basic module
    does not gain a hard, always-on dependency on the app's own policy
    module — it only reaches for kyc_policy at the moment a login attempt is
    actually made.
    """
    import kyc_policy as policy

    key = (username or "").strip().lower()
    return next((u for u in policy.SEED_USERS if u["username"].strip().lower() == key), None)


@router.post("/auth/login")
def login(req: LoginRequest):
    """Mint a session token — but never for a roster identity without its passcode.

    Before slice 4, this endpoint minted a valid bearer token for ANY
    username with no credential check at all, so `POST /auth/login
    {"username": "cora.compliance"}` alone was enough to pass every
    tier-of-approval check downstream that trusts `current_user()`
    (kyc_analyst/senior_analyst/compliance_officer/auditor and the rest of
    kyc_policy.SEED_USERS) — see SLICES.md slice 1 note (vi) and the slice 4
    entry. A username that is NOT one of those named individual accounts
    still logs in freely: it can never resolve to a decision-making role
    (ext_cases.role_of returns None for it), so there is no tier to protect.
    """
    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="username required")
    entry = _roster_entry(username)
    if entry is not None and entry.get("passcode") != req.password:
        raise HTTPException(status_code=401, detail="invalid credentials for a named roster account")
    token = secrets.token_hex(16)
    _sessions[token] = entry["username"] if entry else username
    return {"token": token, "username": _sessions[token]}


def current_user(authorization: str | None) -> str | None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    return _sessions.get(token)


@router.get("/auth/me")
def me(authorization: str | None = Header(default=None)):
    username = current_user(authorization)
    if username is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return {"username": username}
