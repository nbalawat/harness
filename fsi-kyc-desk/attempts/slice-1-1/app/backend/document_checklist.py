"""Document Checklist (approved policy artefact) — REQ-001..014, REQ-055, REQ-070, REQ-094.

The completeness rule is purely mechanical: a fixed set of base documents is
always required for a corporate entity; a small set of additional documents
becomes required only when a case's own attributes/risk factors trigger the
condition. Nothing here is discretionary and nothing here is waivable by an
analyst — a compliance-officer-granted policy exception is a separate,
explicitly-recorded mechanism (see the rbac-tiered-approval slice), never a
checklist edit.
"""
from policy_versions import DOCUMENT_CHECKLIST_VERSION

BASE_REQUIRED = [
    "certificate_of_incorporation",
    "register_of_directors",
    "beneficial_ownership_declaration",
    "proof_of_registered_address",
]


def _deep_ownership_chain(attributes, risk_factors):
    depth = (attributes or {}).get("ownership_chain_depth") or 0
    return depth > 2 or (risk_factors or {}).get("entity_structure") == "chain_depth_over_3"


def _regulated_industry(attributes, risk_factors):
    return bool((attributes or {}).get("regulated_industry"))


def _cross_border_expected(attributes, risk_factors):
    return bool((attributes or {}).get("cross_border_expected"))


# document_type -> {trigger label, check(attributes, risk_factors) -> bool}
CONDITIONAL = {
    "structure_chart": {
        "trigger": "ownership_chain_depth_over_2_or_complex_entity_structure",
        "check": _deep_ownership_chain,
    },
    "operating_license": {
        "trigger": "regulated_industry",
        "check": _regulated_industry,
    },
    "expected_activity_questionnaire": {
        "trigger": "cross_border_expected",
        "check": _cross_border_expected,
    },
}

ALL_ITEMS = BASE_REQUIRED + list(CONDITIONAL.keys())


def resolve_required(attributes, risk_factors):
    """Returns (required_document_types: set[str], triggers_applied: list[dict])."""
    required = set(BASE_REQUIRED)
    triggers = []
    for doc_type, spec in CONDITIONAL.items():
        if spec["check"](attributes, risk_factors):
            required.add(doc_type)
            triggers.append({"document_type": doc_type, "trigger": spec["trigger"]})
    return required, triggers


def describe():
    """The checklist as published — every item, whether it is unconditionally
    required, and the trigger that makes a conditional item required."""
    items = []
    for doc_type in ALL_ITEMS:
        cond = CONDITIONAL.get(doc_type)
        items.append(
            {
                "document_type": doc_type,
                "required": doc_type in BASE_REQUIRED,
                "conditionally_required": cond is not None,
                "condition_trigger": cond["trigger"] if cond else None,
            }
        )
    return {"version": DOCUMENT_CHECKLIST_VERSION, "items": items}
