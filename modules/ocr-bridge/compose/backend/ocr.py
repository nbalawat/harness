"""ocr-bridge module: scans to text with explicit availability. See agent-guide."""
import shutil
import subprocess


class OcrUnavailable(Exception):
    pass


def available():
    return shutil.which("tesseract") is not None


def image_to_text(path):
    if not available():
        raise OcrUnavailable("tesseract is not installed — install it (brew install tesseract) to process scans")
    out = subprocess.run(["tesseract", path, "-", "--psm", "3"], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise OcrUnavailable(f"tesseract failed: {out.stderr[:200]}")
    return out.stdout.strip()
