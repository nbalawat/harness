import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vulnwatch  # noqa: E402


def test_pinned_vulnerable_version_flagged(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("fastapi==0.100.0\nrequests==2.31.0\n# comment\nunpinned\n")
    advisories = [
        {"id": "ADV-1", "package": "requests", "affected_versions": ["2.31.0"], "severity": "high"},
        {"id": "ADV-2", "package": "fastapi", "affected_versions": ["0.1.0"], "severity": "high"},
    ]
    findings = vulnwatch.scan(str(req), advisories)
    assert len(findings) == 1 and findings[0]["package"] == "requests" and findings[0]["severity"] == "high"


def test_missing_file_is_empty_not_crash():
    assert vulnwatch.scan("/nope/requirements.txt", []) == []
