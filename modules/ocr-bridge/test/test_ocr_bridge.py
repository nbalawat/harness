import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ocr  # noqa: E402
import pytest  # noqa: E402


def test_unavailable_is_loud_with_guidance(monkeypatch):
    monkeypatch.setattr(ocr.shutil, "which", lambda _: None)
    assert ocr.available() is False
    with pytest.raises(ocr.OcrUnavailable) as e:
        ocr.image_to_text("scan.png")
    assert "tesseract" in str(e.value)


def test_available_path_invokes_binary(monkeypatch):
    monkeypatch.setattr(ocr.shutil, "which", lambda _: "/usr/bin/tesseract")

    class FakeResult:
        returncode, stdout, stderr = 0, "scanned text ", ""

    monkeypatch.setattr(ocr.subprocess, "run", lambda *a, **k: FakeResult())
    assert ocr.image_to_text("scan.png") == "scanned text"
