"""Standard financial spread template (REQ-010, REQ-011, REQ-012).

Purely mechanical, bank-owned schema — the fixed set of line items the
Financial Spreading Agent's proposal, and this deterministic extractor, must
stay within. Mirrors the pattern in deal_documents.py: the checklist/template
is configuration no agent may expand or shrink at runtime.
"""

STANDARD_SPREAD_TEMPLATE = [
    {"key": "revenue", "label": "Revenue"},
    {"key": "ebitda", "label": "EBITDA"},
    {"key": "net_income", "label": "Net income"},
    {"key": "total_assets", "label": "Total assets"},
    {"key": "total_debt", "label": "Total debt"},
    {"key": "current_assets", "label": "Current assets"},
    {"key": "current_liabilities", "label": "Current liabilities"},
    {"key": "annual_debt_service", "label": "Annual debt service"},
]

TEMPLATE_KEYS = [item["key"] for item in STANDARD_SPREAD_TEMPLATE]
TEMPLATE_LABELS = {item["key"]: item["label"] for item in STANDARD_SPREAD_TEMPLATE}


def describe():
    return {"version": "v1", "items": STANDARD_SPREAD_TEMPLATE}
