"""Shared policy-artefact version identifiers.

Single source of truth for the version strings recorded on every case, so the
document checklist, risk rating matrix and onboarding policy versions a case
was evaluated against stay traceable and reproducible (REQ-070, REQ-089,
REQ-091). Later slices (risk scoring, memo drafting) import these rather than
inventing their own version strings. Never change an already-shipped version
string retroactively — bump it and let cases keep the version they were
actually evaluated against.
"""

DOCUMENT_CHECKLIST_VERSION = "document-checklist-v1"
RISK_MATRIX_VERSION = "risk-rating-matrix-v1"
ONBOARDING_POLICY_VERSION = "kyc-onboarding-policy-v1"
