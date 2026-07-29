import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


def test_export_contains_inserted_rows_and_header():
    client.post("/api/conversations", json={"user": "csv-user"})
    body = client.get("/export/conversations.csv").text
    lines = body.strip().split("\n")
    assert lines[0].startswith("id,")
    assert any("csv-user" in line for line in lines[1:])


def test_unknown_table_404():
    assert client.get("/export/not-a-table.csv").status_code == 404
