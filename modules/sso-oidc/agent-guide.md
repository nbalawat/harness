# sso-oidc — agent guide

Identity in production comes from the firm IdP (Okta/Azure AD), not
from app-local logins. validate_id_token enforces issuer, audience, and expiry;
signature verification is delegated to the gateway in v0 (APP_OIDC_DEV=1
acknowledges this explicitly — production deployments terminate JWS upstream).
Never read claims from an unvalidated token.
