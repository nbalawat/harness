"""doc-extract module: documents to clean text. See agent-guide."""
import html.parser
import os
import re
import shutil
import subprocess
import zipfile


class _HtmlText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def _from_html(raw):
    p = _HtmlText()
    p.feed(raw)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(s.strip() for s in p.parts if s.strip()))


def _from_docx(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"<w:p[ >].*?</w:p>", lambda m: re.sub(r"<[^>]+>", "", m.group(0)) + "\n", xml, flags=re.S)
    return re.sub(r"<[^>]+>", "", text).strip()


def extract(path):
    ext = os.path.splitext(path)[1].lower()
    warnings = []
    if ext in (".txt", ".md"):
        text = open(path, encoding="utf-8", errors="replace").read()
    elif ext in (".html", ".htm"):
        text = _from_html(open(path, encoding="utf-8", errors="replace").read())
    elif ext == ".docx":
        text = _from_docx(path)
    elif ext == ".pdf":
        if shutil.which("pdftotext"):
            out = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, timeout=60)
            text = out.stdout
        else:
            text, warnings = "", ["pdf extraction requires pdftotext (poppler) — not installed"]
    else:
        text, warnings = "", [f"unsupported format '{ext}'"]
    return {"text": text.strip(), "format": ext.lstrip("."), "warnings": warnings}
