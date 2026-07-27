import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_allowlisted_upload_roundtrips():
    assert client.put("/uploads/notes.txt", content=b"hello").status_code == 200
    assert client.get("/files/notes.txt").content == b"hello"


def test_disallowed_extension_and_empty_body():
    assert client.put("/uploads/evil.exe", content=b"MZ").status_code == 415
    assert client.put("/uploads/empty.txt", content=b"").status_code == 400


def test_oversize_rejected(monkeypatch):
    monkeypatch.setenv("APP_BLOB_MAX_BYTES", "10")
    assert client.put("/uploads/big.txt", content=b"x" * 100).status_code == 413
