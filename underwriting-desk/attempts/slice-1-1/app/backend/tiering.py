"""Deterministic approval-tier derivation from exposure amount (REQ-043,
REQ-054). Never computed by an agent — the approval endpoint (a later slice)
re-derives this same value server-side and rejects any decision above it.
"""

TIER_ANALYST = "credit_analyst"
TIER_SENIOR_OFFICER = "senior_credit_officer"
TIER_COMMITTEE = "credit_committee"

ANALYST_CEILING = 250_000
SENIOR_OFFICER_CEILING = 1_000_000

TIER_REQUIRED_ROLE = {
    TIER_ANALYST: "credit_analyst",
    TIER_SENIOR_OFFICER: "senior_credit_officer",
    TIER_COMMITTEE: "credit_committee",
}

TIER_RULE_VERSION = "tier-rules@2026.1"


def derive_tier(exposure_amount) -> str:
    amount = float(exposure_amount)
    if amount <= ANALYST_CEILING:
        return TIER_ANALYST
    if amount <= SENIOR_OFFICER_CEILING:
        return TIER_SENIOR_OFFICER
    return TIER_COMMITTEE


def required_role(tier: str) -> str:
    return TIER_REQUIRED_ROLE.get(tier, TIER_COMMITTEE)
