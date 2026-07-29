import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import base64  # noqa: E402
import json  # noqa: E402

import oidc  # noqa: E402
import pytest  # noqa: E402


def make_token(claims):
    def seg(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{seg({'alg': 'none'})}.{seg(claims)}.sig"


def test_valid_token_yields_claims(monkeypatch):
    monkeypatch.setenv("APP_OIDC_DEV", "1")
    claims = oidc.validate_id_token(
        make_token({"iss": "https://idp.firm.com", "aud": "my-app", "exp": 9999999999, "sub": "u1"}),
        audience="my-app", issuer="https://idp.firm.com",
    )
    assert claims["sub"] == "u1"


def test_wrong_audience_expiry_and_prod_guard(monkeypatch):
    monkeypatch.setenv("APP_OIDC_DEV", "1")
    good = {"iss": "https://idp.firm.com", "aud": "my-app", "exp": 9999999999, "sub": "u1"}
    with pytest.raises(oidc.InvalidToken):
        oidc.validate_id_token(make_token({**good, "aud": "other"}), "my-app", "https://idp.firm.com")
    with pytest.raises(oidc.InvalidToken):
        oidc.validate_id_token(make_token({**good, "exp": 1}), "my-app", "https://idp.firm.com")
    monkeypatch.delenv("APP_OIDC_DEV")
    with pytest.raises(oidc.InvalidToken):
        oidc.validate_id_token(make_token(good), "my-app", "https://idp.firm.com")


def test_auth_url_carries_state():
    url = oidc.auth_url("https://idp/authorize", "cid", "https://app/cb", "xyz")
    assert "state=xyz" in url and "client_id=cid" in url
