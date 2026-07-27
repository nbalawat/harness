"""multi-env module: layered environments with prod rails. See agent-guide."""

_PROD_FORBIDDEN = {"APP_DEBUG": ("1", "true", "yes"), "APP_ALLOW_SEED": ("1",)}


class ProdGuardViolation(Exception):
    pass


def load_env_file(text):
    out = {}
    for line in str(text).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def merge(base, overlay, env_name="dev"):
    merged = {**base, **overlay}
    if env_name == "prod":
        for key, forbidden in _PROD_FORBIDDEN.items():
            if str(merged.get(key, "")).lower() in forbidden:
                raise ProdGuardViolation(f"{key} must not be enabled in prod")
    return merged
