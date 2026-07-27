import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zipfile  # noqa: E402

import doc_extract  # noqa: E402


def test_txt_html_and_docx(tmp_path):
    (tmp_path / "a.txt").write_text("plain text doc")
    assert doc_extract.extract(str(tmp_path / "a.txt"))["text"] == "plain text doc"

    (tmp_path / "b.html").write_text("<html><script>evil()</script><body><h1>Title</h1><p>Body text.</p></body></html>")
    html_out = doc_extract.extract(str(tmp_path / "b.html"))["text"]
    assert "Title" in html_out and "Body text." in html_out and "evil" not in html_out

    docx = tmp_path / "c.docx"
    with zipfile.ZipFile(docx, "w") as z:
        z.writestr("word/document.xml", '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Docx paragraph.</w:t></w:r></w:p></w:body></w:document>')
    assert "Docx paragraph." in doc_extract.extract(str(docx))["text"]


def test_unsupported_warns_instead_of_crashing(tmp_path):
    (tmp_path / "d.xyz").write_text("?")
    result = doc_extract.extract(str(tmp_path / "d.xyz"))
    assert result["text"] == "" and result["warnings"]
