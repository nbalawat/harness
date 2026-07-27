import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
import secrets_mgr  # noqa: E402


def test_env_backed_and_loud_when_missing(monkeypatch):
    monkeypatch.setenv("APP_DB_PASSWORD", "s3cret-value")
    assert secrets_mgr.get("APP_DB_PASSWORD") == "s3cret-value"
    with pytest.raises(secrets_mgr.MissingSecret):
        secrets_mgr.get("NEVER_SET_SECRET")
    assert secrets_mgr.get("NEVER_SET_SECRET", required=False) is None


def test_scanner_flags_hardcoded_literals(tmp_path):
    bad = tmp_path / "bad.py"
    bad.write_text('api_key = "sk-aaaabbbbccccdddd1234"\n')
    ok = tmp_path / "ok.py"
    ok.write_text('import secrets_mgr\nkey = secrets_mgr.get("API_KEY")\n')
    findings = secrets_mgr.scan_source(str(tmp_path))
    assert len(findings) == 1 and findings[0]["file"].endswith("bad.py")
