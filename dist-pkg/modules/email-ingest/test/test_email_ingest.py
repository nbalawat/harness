import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import email_ingest  # noqa: E402
from db import store  # noqa: E402

EML = (
    "From: analyst@firm.com\r\n"
    "To: app@firm.com\r\n"
    "Subject: Password reset question\r\n"
    "Content-Type: text/plain\r\n\r\n"
    "How do I reset a user's access?\r\n"
)


def test_parse_and_dedupe(tmp_path):
    (tmp_path / "m1.eml").write_text(EML)
    first = email_ingest.scan_dropdir(str(tmp_path), store)
    assert first == ["m1.eml"]
    row = store.list("_ingested_mail")[0]
    assert row["subject"] == "Password reset question" and "reset" in row["body"]
    assert email_ingest.scan_dropdir(str(tmp_path), store) == [], "already-ingested mail skipped"
