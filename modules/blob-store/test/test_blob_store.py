import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import blob_store  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_http_roundtrip():
    assert client.put("/files/report.txt", content=b"hello blob", headers={"x-user-email": "tester@local"}).status_code == 200
    assert client.get("/files/report.txt").content == b"hello blob"


def test_traversal_is_neutralized():
    stored = blob_store.save("../../etc/passwd", b"x")
    assert "/" not in stored and stored == "passwd"


def test_missing_404():
    assert client.get("/files/never.bin").status_code == 404


def test_upload_requires_identity():
    assert client.put("/files/anon.txt", content=b"x").status_code == 401
