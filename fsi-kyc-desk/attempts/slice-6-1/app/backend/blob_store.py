"""blob-store module: file content behind one interface. See agent-guide."""
import os
import re

_DIR = os.environ.get("APP_BLOB_DIR") or os.path.join(os.path.dirname(__file__), "..", "data", "blobs")


def _safe(name):
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(name))
    if not clean or clean.startswith("."):
        raise ValueError("invalid blob name")
    return clean


def save(name, data: bytes):
    limit = int(os.environ.get("APP_BLOB_MAX_BYTES", str(10 * 1024 * 1024)))
    if len(data) > limit:
        raise ValueError("blob too large")
    os.makedirs(_DIR, exist_ok=True)
    path = os.path.join(_DIR, _safe(name))
    with open(path, "wb") as f:
        f.write(data)
    return _safe(name)


def get(name) -> bytes:
    with open(os.path.join(_DIR, _safe(name)), "rb") as f:
        return f.read()


def list_blobs():
    return sorted(os.listdir(_DIR)) if os.path.isdir(_DIR) else []
