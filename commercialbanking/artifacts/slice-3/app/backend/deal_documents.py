"""Required document checklist for intake triage (REQ-007).

Purely mechanical: a fixed base checklist is compared against the artifact
types actually stored on the deal. Nothing here is discretionary — the
Intake Triage Agent reads this same checklist (see roster.json) but never
decides what belongs on it.
"""

CHECKLIST_VERSION = "v1"

# artifact_type (as submitted on /deals/intake) -> the checklist item it satisfies
ARTIFACT_TYPE_TO_DOCUMENT = {
    "email": "loan_application_email",
    "spreadsheet": "financial_statements",
    "financial_statement": "financial_statements",
    "tax_return": "tax_returns",
    "collateral_document": "collateral_documentation",
    "appraisal": "collateral_documentation",
}

BASE_REQUIRED_DOCUMENTS = [
    "loan_application_email",
    "financial_statements",
    "tax_returns",
    "collateral_documentation",
]


def resolve_missing(present_artifact_types):
    """Returns (missing_documents: list[str], covered_documents: set[str])."""
    covered = {ARTIFACT_TYPE_TO_DOCUMENT.get(t) for t in present_artifact_types}
    covered.discard(None)
    missing = [doc for doc in BASE_REQUIRED_DOCUMENTS if doc not in covered]
    return missing, covered


def describe():
    return {
        "version": CHECKLIST_VERSION,
        "items": [{"document_type": doc, "required": True} for doc in BASE_REQUIRED_DOCUMENTS],
    }
