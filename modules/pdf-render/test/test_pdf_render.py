import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdf  # noqa: E402


def test_output_is_structurally_valid_pdf_with_content():
    data = pdf.render("Approval Record", ["Item: Q3 report", "Decision: approved (ana)"])
    assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF")
    assert b"Approval Record" in data and b"Decision: approved" in data
    assert data.count(b"endobj") == 5 and b"xref" in data


def test_parens_escaped():
    data = pdf.render("T", ["danger (unbalanced"])
    assert rb"\(unbalanced" in data
