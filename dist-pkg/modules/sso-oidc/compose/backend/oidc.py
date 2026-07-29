"""sso-oidc module: OIDC token validation + auth URL. See agent-guide."""
import base64
import json
import os
import time
import urllib.parse


class InvalidToken(Exception):
    pass


def _b64json(segment):
    padded = segment + "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def validate_id_token(token, audience, issuer, now=None):
    if os.environ.get("APP_OIDC_DEV") != "1":
        raise InvalidToken("v0 validates claims only — set APP_OIDC_DEV=1 behind a JWS-terminating gateway")
    try:
        _header, payload, _sig = token.split(".")
        claims = _b64json(payload)
    except Exception as e:
        raise InvalidToken(f"malformed token: {e}")
    now = now or time.time()
    if claims.get("iss") != issuer:
        raise InvalidToken("wrong issuer")
    aud = claims.get("aud")
    if audience not in (aud if isinstance(aud, list) else [aud]):
        raise InvalidToken("wrong audience")
    if float(claims.get("exp", 0)) < now:
        raise InvalidToken("expired")
    if not claims.get("sub"):
        raise InvalidToken("no subject")
    return claims


def auth_url(base, client_id, redirect_uri, state):
    query = urllib.parse.urlencode(
        {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "scope": "openid profile", "state": state}
    )
    return f"{base}?{query}"
