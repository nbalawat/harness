"""Shared underwriting stage definitions — single source of truth for the
pipeline's 8-stage order and legal transitions (REQ-001). Built on the
state-machine module; every slice that moves a deal between stages should
import `machine` from here rather than redeclaring the transition table.
"""
from statemachine import Machine

STAGES = [
    "intake",
    "document_extraction",
    "financial_spreading",
    "risk_grading",
    "memo_drafting",
    "policy_compliance",
    "approval",
    "closing",
]

STAGE_LABELS = {
    "intake": "Intake",
    "document_extraction": "Document Extraction",
    "financial_spreading": "Financial Spreading",
    "risk_grading": "Risk Grading",
    "memo_drafting": "Memo Drafting",
    "policy_compliance": "Policy Compliance",
    "approval": "Tiered Approval",
    "closing": "Closing",
}

# Deterministic-code stages never touched by an agent or a human draft.
CODE_STAGES = {"risk_grading"}

_TRANSITIONS = {
    "intake": {"advance": "document_extraction"},
    "document_extraction": {"advance": "financial_spreading"},
    "financial_spreading": {"advance": "risk_grading", "return": "document_extraction"},
    "risk_grading": {"advance": "memo_drafting"},
    "memo_drafting": {"advance": "policy_compliance", "return": "financial_spreading"},
    "policy_compliance": {"advance": "approval", "return": "memo_drafting"},
    "approval": {"advance": "closing", "return": "financial_spreading"},
    "closing": {},
}

machine = Machine(_TRANSITIONS, initial="intake")


def stage_index(stage: str) -> int:
    return STAGES.index(stage) if stage in STAGES else -1


def stage_label(stage: str) -> str:
    return STAGE_LABELS.get(stage, stage)
