# ocr-bridge — agent guide

Check ocr.available() before offering scan flows; image_to_text raises
OcrUnavailable with install guidance when tesseract is absent — NEVER return
empty text for a scan (silent data loss). Extracted text feeds doc-extract's
normal path.
